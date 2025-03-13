import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import loadConfig from './src/loadConfig.js';
import loadWallets from './src/loadWallets.js';
import { getBondingCurve } from './src/getKeys.js';
import { createTX } from './src/createTX.js';
import { createSellTX } from './src/createSellTX.js';
import BN from 'bn.js';
import { BondingCurveLayout } from './src/PUMP_LAYOUT.js';
import humanBuyAmount from './src/pumpCalcBuy.js'; // Used for a more accurate token calculation

// Inline buyQuote for diagnostic purposes (calculates estimated token output based on bonding curve reserves)
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

async function main() {
  // Load configuration (e.g., RPC URL, slippage, minBuy, maxBuy, etc.)
  const config = await loadConfig();

  // Connect to Solana using "confirmed" commitment for faster response
  const connection = new Connection(config.rpcURL, {
    commitment: 'confirmed',
    wsEndpoint: config.wsURL
  });

  // Load wallets and select the first one for this transaction
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.error("No wallets found in wallets.txt");
    process.exit(1);
  }
  const wallet = wallets[0];

  // Get the mint (coin contract) address from the command line arguments
  const coinCA = process.argv[2];
  if (!coinCA) {
    console.error("Usage: node simpleBuy.js <coin-contract-address>");
    process.exit(1);
  }

  // Randomly choose a buy amount in SOL between minBuy and maxBuy and convert it to lamports
  const minBuy = config.minBuy;
  const maxBuy = config.maxBuy;
  const buyAmountSOL = Math.random() * (maxBuy - minBuy) + minBuy;
  const buyAmountLamports = Math.floor(buyAmountSOL * 1e9);
  console.log("Buy Amount (SOL):", buyAmountSOL.toFixed(9));

  // Calculate the maximum SOL cost allowed based on the slippage setting (e.g., 15% extra)
  const configuredMaxSolCost = buyAmountLamports + Math.floor(buyAmountLamports * config.slippage);
  console.log("Configured maxSolCost (lamports):", configuredMaxSolCost);

  // Compute the bonding curve PDA and the associated token account (ATA)
  const mintPubKey = new PublicKey(coinCA);
  const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
  const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);

  // Retrieve current bonding curve state to see pool reserves
  const bcAccountInfo = await connection.getAccountInfo(bondingCurvePda);
  if (!bcAccountInfo || !bcAccountInfo.data) {
    console.error("Failed to fetch bonding curve account data.");
    process.exit(1);
  }
  const reservesDecoded = BondingCurveLayout.deserialize(bcAccountInfo.data);
  console.log("Bonding Curve Reserves:");
  console.log("  Virtual SOL Reserves:", reservesDecoded.virtualSolReserves.toString());
  console.log("  Virtual Token Reserves:", reservesDecoded.virtualTokenReserves.toString());
  console.log("  Real Token Reserves:", reservesDecoded.realTokenReserves.toString());

  // Estimate token output (in base units) using buyQuote (for diagnostic comparison)
  const estimatedTokensInline = buyQuote(
    new BN(buyAmountLamports),
    {
      virtualSolReserves: new BN(reservesDecoded.virtualSolReserves.toString()),
      virtualTokenReserves: new BN(reservesDecoded.virtualTokenReserves.toString()),
      realTokenReserves: new BN(reservesDecoded.realTokenReserves.toString())
    }
  );
  console.log("Estimated token output from buyQuote (base units):", estimatedTokensInline.toString());
  const tokenDecimals = 6; // Assume token uses 6 decimals
  const humanEstimatedTokensInline = estimatedTokensInline.toNumber() / Math.pow(10, tokenDecimals);
  console.log(`Tokens you can buy with ${buyAmountSOL.toFixed(9)} SOL (buyQuote):`, humanEstimatedTokensInline);

  // Use humanBuyAmount (used in staggerBuy) for the accurate intended token output
  const estimatedTokensHumanRaw = await humanBuyAmount(bondingCurvePda, buyAmountLamports);
  // Convert humanBuyAmount result (in token units) to base units by multiplying by 1e6
  const estimatedTokensHuman = new BN(Math.floor(estimatedTokensHumanRaw * 1e6));
  const humanEstimatedTokens = estimatedTokensHuman.toNumber() / Math.pow(10, tokenDecimals);
  console.log(`Tokens you can buy with ${buyAmountSOL.toFixed(9)} SOL (humanBuyAmount):`, humanEstimatedTokens);

  // Build the buy transaction via createTX (which multiplies the token amount by 1e6)
  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 });
  const txObj = await createTX(
    mintPubKey,
    bondingCurvePda,
    bondingCurveAta,
    pumpProgramId,
    wallet,
    buyAmountLamports,
    config.slippage
  );
  // Add the compute budget instruction at the beginning of the instruction array
  txObj.instructions.unshift(computePriceIx);

  // --- PATCH THE PUMP.FUN BUY INSTRUCTION ---
  // In createTX, the token amount is multiplied by 1e6. We patch this field so it equals the correct amount
  // based on humanBuyAmount (which should be the intended token output in base units).
  if (txObj.instructions.length > 2) {
    const pumpIx = txObj.instructions[2];
    const pumpData = Buffer.from(pumpIx.data); // Make a mutable copy of the instruction data
    // The instruction layout:
    // Byte 0: opcode, bytes 1-7: constant prefix, bytes 8-15: token amount, bytes 16-23: maxSolCost.
    // Overwrite bytes 8-15 with the correct token amount from humanBuyAmount.
    const correctTokenBuffer = Buffer.alloc(8);
    correctTokenBuffer.writeBigUInt64LE(BigInt(estimatedTokensHuman.toString()), 0);
    correctTokenBuffer.copy(pumpData, 8);
    pumpIx.data = pumpData;
    // Diagnostic: read back the patched token amount and compute scaling factor.
    const txTokenAmountBigInt = pumpData.readBigUInt64LE(8);
    const txTokenAmountBN = new BN(txTokenAmountBigInt.toString());
    console.log("Patched transaction token amount (base units):", txTokenAmountBN.toString());
    const scalingFactor = txTokenAmountBN.div(estimatedTokensHuman);
    console.log("Scaling factor (should be 1):", scalingFactor.toString());
    if (!scalingFactor.eq(new BN(1))) {
      console.warn("Warning: The patched token amount does not match the humanBuyAmount output.");
    }
  }

  // --- SEND THE BUY TRANSACTION ---
  const latestBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const messageV0 = new TransactionMessage({
    payerKey: txObj.payer.publicKey,
    instructions: txObj.instructions,
    recentBlockhash: latestBlockhash,
  }).compileToV0Message();
  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([txObj.payer]);

  let buyTxid;
  try {
    buyTxid = await connection.sendTransaction(versionedTx, {
      skipPreflight: true,
      commitment: 'confirmed'
    });
    console.log("Buy transaction sent. TXID:", buyTxid);
  } catch (sendErr) {
    console.error("Error sending buy transaction:", sendErr);
    process.exit(1);
  }

  // Confirm the buy transaction on-chain
  let confirmation;
  try {
    confirmation = await connection.confirmTransaction(buyTxid, "confirmed");
  } catch (confirmErr) {
    console.error("Error confirming buy transaction:", confirmErr);
    process.exit(1);
  }
  if (!confirmation.value) {
    console.error("Buy transaction confirmation response is empty or null.");
    process.exit(1);
  }
  if (confirmation.value.err) {
    console.error("Buy transaction failed on-chain. Error details:", confirmation.value.err);
    process.exit(1);
  }
  console.log("Buy transaction confirmed at slot:", confirmation.context.slot);

  // Wait 20 seconds before starting the sell transaction
  await new Promise(resolve => setTimeout(resolve, 1000));

  // --- BUILD THE SELL TRANSACTION ---
  // Fetch the token account for the mint owned by our wallet
  const tokenAccounts = await connection.getTokenAccountsByOwner(
    new PublicKey(wallet.pubKey),
    { mint: mintPubKey }
  );
  if (tokenAccounts.value.length === 0) {
    console.error("No token account found for mint", coinCA);
    process.exit(1);
  }
  const tokenAccountPubKey = tokenAccounts.value[0].pubkey;
  // Get the token balance from the token account
  const tokenBalanceResult = await connection.getTokenAccountBalance(tokenAccountPubKey);
  const rawSellAmount = tokenBalanceResult.value.amount;
  const uiSellAmount = tokenBalanceResult.value.uiAmount;
  const decimals = tokenBalanceResult.value.decimals;
  
  // Calculate fee in token base units based on jitoTip amount and token decimals, then compute net sell amount
  const feeRaw = Math.floor(parseFloat(config.jitoTipAmount) * Math.pow(10, decimals));
  const netSellRaw = parseInt(rawSellAmount, 10) - feeRaw;
  
  console.log("Sell Fee Breakdown:");
  console.log("  Sell Amount:", rawSellAmount, "raw units →", uiSellAmount, "tokens");
  console.log("  Fixed Fee:", feeRaw, "raw units →", (feeRaw / Math.pow(10, decimals)).toFixed(decimals), "tokens");
  console.log("  Net Sell Amount:", netSellRaw, "raw units →", (netSellRaw / Math.pow(10, decimals)).toFixed(decimals), "tokens");
  
  // Build the sell transaction using createSellTX
  const sellTxObj = await createSellTX(
    mintPubKey,
    bondingCurvePda,
    bondingCurveAta,
    pumpProgramId,
    wallet,
    netSellRaw,
    tokenAccountPubKey.toBase58()
  );
  const latestBlockhashSell = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const messageV0Sell = new TransactionMessage({
    payerKey: sellTxObj.payer.publicKey,
    instructions: sellTxObj.instructions,
    recentBlockhash: latestBlockhashSell,
  }).compileToV0Message();
  const versionedSellTx = new VersionedTransaction(messageV0Sell);
  versionedSellTx.sign([sellTxObj.payer]);
  
  let sellTxid;
  try {
    sellTxid = await connection.sendTransaction(versionedSellTx, {
      skipPreflight: true,
      commitment: 'confirmed'
    });
    console.log("Sell transaction sent. TXID:", sellTxid);
  } catch (err) {
    console.error("Error sending sell transaction:", err);
    process.exit(1);
  }
}
  
main().catch(err => {
  console.error("Error in simpleBuy.js:", err);
});
