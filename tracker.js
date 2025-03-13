// tracker.js

import { Connection, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import readline from 'readline';
import chalk from 'chalk';
import Table from 'cli-table3';

// ─── CONFIGURATION ─────────────────────────────────────────────

// Controlled wallet addresses (your wallets)
const controlledWallets = [
  '21yUropTMPZ1qwoLLXKJaQUfnE3rMchMk1ymdXrLzPHK',
  'G2CLx5UDKZwrQUS3Jv6pZgTiEYN185Ge4RPkCdrA6uHy'
];

// The pump fun token mint address (replace with your pump token’s mint)
const PUMP_TOKEN_MINT = "B9WPbJASTbPsMfAt8DzGuuDVX8Fe2Np1F4cZzG1Spump";

// Standard SPL Token Program ID
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Total supply of the token (set to 1,000,000,000 tokens)
const TOTAL_SUPPLY = 1000000000;

// ─── GLOBAL VARIABLES ───────────────────────────────────────────

/*
  We'll store holder data in a Map keyed by the token account public key.
  Each value is an object with:
    - owner: the wallet address owning that token account
    - tokenAmount: the current token amount (uiAmount)
    - slot: the latest slot from the notification
    - lastUpdated: the ISO timestamp of the last change in tokenAmount
*/
const holders = new Map();

// Helius endpoints (replace YOUR_HELIUS_API_KEY with your actual key)
const HELIUS_WS_ENDPOINT = "wss://mainnet.helius-rpc.com/?api-key=7b7ac854-fbdf-413f-be38-a6faab746fc9";
const HELIUS_RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=7b7ac854-fbdf-413f-be38-a6faab746fc9";

// Create an RPC connection (using finalized commitment)
const connection = new Connection(HELIUS_RPC_ENDPOINT, "finalized");

// ─── FUNCTIONS ─────────────────────────────────────────────────

// Fetch initial token holders from the RPC endpoint
async function fetchInitialHolders() {
  console.log(chalk.blue("Fetching initial holders..."));
  try {
    const parsedAccounts = await connection.getParsedProgramAccounts(
      new PublicKey(TOKEN_PROGRAM_ID),
      {
        encoding: "jsonParsed",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: PUMP_TOKEN_MINT,
            },
          },
          { dataSize: 165 }
        ]
      }
    );
    for (const acc of parsedAccounts) {
      const pubkey = acc.pubkey.toBase58();
      const info = acc.account.data.parsed.info;
      // Only add if the token amount is > 0.
      if (Number(info.tokenAmount.uiAmount) > 0) {
        holders.set(pubkey, {
          owner: info.owner, // full wallet address
          tokenAmount: info.tokenAmount.uiAmount,
          slot: "-", // initial slot not available
          lastUpdated: new Date().toISOString(),
        });
      }
    }
    refreshTable();
  } catch (error) {
    console.error(chalk.red("Error fetching initial holders:"), error);
  }
}

// Helper: Format a timestamp into "X minutes ago"
function formatMinutesAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  return minutes <= 0 ? "just now" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

// Refresh the on‑screen table with sorting, filtering, and automatic liquidity pool identification
function refreshTable() {
  // Clear the console
  console.clear();
  console.log(chalk.green("Current Pump Token Holders"));
  
  // Create a table with headers: Wallet Address, Token %, Last Updated.
  // Increase the wallet address column width and enable word wrapping.
  const table = new Table({
    head: ['Wallet Address', 'Token %', 'Last Updated'],
    colWidths: [80, 20, 25],
    wordWrap: true
  });

  // Convert holders Map to an array, calculate percentage, filter out holdings below 0.4%,
  // and sort from highest to lowest percentage.
  const sortedHolders = Array.from(holders.values())
    .map(data => {
      const percentage = (data.tokenAmount / TOTAL_SUPPLY) * 100;
      return {
        owner: data.owner,
        tokenAmount: data.tokenAmount,
        percentage,
        lastUpdated: data.lastUpdated
      };
    })
    .filter(item => item.percentage >= 0.4)
    .sort((a, b) => b.percentage - a.percentage);

  // Determine the maximum percentage (assumed to be the liquidity pool)
  const maxPercentage = sortedHolders.length > 0 ? sortedHolders[0].percentage : 0;

  // Populate the table with sorted data.
  sortedHolders.forEach(data => {
    let ownerDisplay = data.owner;
    if (data.percentage === maxPercentage) {
      ownerDisplay += " 💧";
    }
    const percentageStr = data.percentage.toFixed(2) + '%';
    const lastUpdated = formatMinutesAgo(data.lastUpdated);
    table.push([ownerDisplay, percentageStr, lastUpdated]);
  });
  
  console.log(table.toString());
  console.log(chalk.yellow("Press 'q' then Enter at any time to quit."));
}

// ─── READLINE SETUP FOR QUITTING ─────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', (input) => {
  if (input.trim().toLowerCase() === 'q') {
    console.log(chalk.yellow("Quitting: closing WebSocket connection..."));
    ws.close();
    rl.close();
    process.exit(0);
  }
});

// ─── WEBSOCKET SUBSCRIPTION SETUP ───────────────────────────

const ws = new WebSocket(HELIUS_WS_ENDPOINT);

ws.on('open', () => {
  console.log(chalk.blue("Connected to Helius WebSocket."));
  // Prepare the subscription request for token accounts of our pump token.
  const subscriptionRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "programSubscribe",
    params: [
      TOKEN_PROGRAM_ID,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: PUMP_TOKEN_MINT,
            },
          },
          { dataSize: 165 }
        ]
      }
    ]
  };
  console.log(chalk.blue("Subscription request sent:"), JSON.stringify(subscriptionRequest, null, 2));
  ws.send(JSON.stringify(subscriptionRequest));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    // If this is the subscription confirmation, just log it.
    if (message.id === 1 && message.result) {
      console.log(chalk.blue("Subscription confirmed. Subscription ID:"), message.result);
      return;
    }
    // Process program notifications with parsed account data.
    if (message.method === "programNotification") {
      const result = message.params.result;
      // Use the correct path for parsed account data
      if (result && result.value && result.value.account && result.value.account.data && result.value.account.data.parsed) {
        const pubkey = result.value.pubkey;
        const parsedInfo = result.value.account.data.parsed;
        const owner = parsedInfo.info.owner;
        const tokenAmount = parsedInfo.info.tokenAmount.uiAmount;
        const slot = result.context.slot;
        // Check if we already have a record for this pubkey.
        const existing = holders.get(pubkey);
        if (existing) {
          // If the token amount has changed, update both tokenAmount and lastUpdated.
          if (existing.tokenAmount !== tokenAmount) {
            holders.set(pubkey, {
              owner,
              tokenAmount,
              slot,
              lastUpdated: new Date().toISOString(),
            });
          } else {
            // Token amount is the same; update slot but keep lastUpdated unchanged.
            holders.set(pubkey, {
              owner,
              tokenAmount,
              slot,
              lastUpdated: existing.lastUpdated,
            });
          }
        } else {
          // New account: add it with current timestamp.
          holders.set(pubkey, {
            owner,
            tokenAmount,
            slot,
            lastUpdated: new Date().toISOString(),
          });
        }
        refreshTable();
      }
    }
  } catch (e) {
    console.error(chalk.red("Error parsing message:"), e);
  }
});

ws.on('error', (error) => {
  console.error(chalk.red("WebSocket error:"), error);
});

ws.on('close', () => {
  console.log(chalk.yellow("WebSocket connection closed."));
});

// ─── STARTUP ─────────────────────────────────────────────────────

console.log(chalk.green("My controlled wallets:"), controlledWallets);
console.log(chalk.yellow("Press 'q' then Enter at any time to quit."));
fetchInitialHolders();
