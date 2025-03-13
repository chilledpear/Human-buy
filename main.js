// main.js
import readline from 'readline';
import chalk from 'chalk';
import fs from 'fs';

// Import all the mode functions
import buyThePumpJito from './src/jitoBuy.js';
import sellTheDump from './src/pumpSell.js';
import raySell from './src/raydium/sell.js';
import genWallet from './src/walletGen.js';
import distro from './src/distro.js';
import refund from './src/refund.js';
import checkBalances from './src/balances.js';
import walletTracker from './src/walletMonitor.js';
import humanMode from './src/humanMode.js';
import staggerBuy from './src/staggerBuy.js';
import closeTokenAccounts from './src/closeAccounts.js';
import sendSPL from './src/transferSPL.js';
import singleSell from './src/singleSell.js';
import microBuySpam from './src/microBuy.js';
import createPumpProfiles from './src/profile/main.js';
import buyAndSell from './src/sameTX.js';
import cleanup from './src/cleanup.js';
import warmupWallets from './src/warmup.js';
import delaySell from './src/delaySell.js';
import unwrapWSOL from './src/raydium/unwrap.js';
import promptBuyAmounts from './src/buyAmt.js';
import { rapidBuyMode1, rapidBuyMode2 } from './src/rapidBuy.js';
import multipleSell from './src/multipleSell.js'; // Import the new multiple wallet sell feature
import multiTimedSell from './src/multiTimedsell.js'; // Import the multi wallet timed sell feature
import './src/hotkeySell.js';
import humanbuy from './src/humanbuy.js';




// Import and initialize hotkeySell so that the "=" key is active globally
import { initHotkeySell } from './src/hotkeySell.js';
initHotkeySell();

process.removeAllListeners('warning');
process.removeAllListeners('ExperimentalWarning');

// Set up readline interface for the menu
let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function promptUser(promptText) {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      resolve(answer);
    });
  });
}

rl.on('SIGINT', () => {
  process.exit();
});

// Print ASCII art header
async function printAscii() {
  const ascii = fs.readFileSync('./ascii.txt', 'utf8');
  console.log("\n");
  console.log(chalk.hex('#4ECDC4')(ascii));
  console.log(chalk.green("By MoneyPrinters\n"));
}   

printAscii();

// Main menu: shows available modes and also displays info about the global hotkey.
async function mainMenu() {
  console.log(chalk.bgBlack.green('\n=== Main Menu ===\n'));
  console.log(chalk.bold.red('CTRL + C to exit at any point\n'));
  console.log(chalk.yellow('1:') + chalk.hex('#4ECDC4')(' Buy Modes'));
  console.log(chalk.yellow('2:') + chalk.hex('#FF6B6B')(' Sell Modes')); 
  console.log(chalk.yellow('3:') + chalk.hex('#45B7D1')(' Wallets'));
  console.log(chalk.yellow('4:') + chalk.hex('#FF8C42')(' Transfer'));
  console.log(chalk.yellow('Q:') + chalk.hex('#C04CFD')(' Quit'));
  console.log(chalk.magenta("Hotkey '=' is active globally to sell the last three buyer wallets."));
  console.log(chalk.magenta("Hotkey '/' is active globally to pause/resume any ongoing process."));
  const action = await promptUser("\n--> ");
  return action.toUpperCase();
}

// Sub-menu functions (unchanged from your original code)
async function buyMenu() {
  console.clear();
  console.log(chalk.bgCyan.black('\n=== Buy Modes ===\n'));
  console.log(chalk.yellow('1:') + chalk.hex('#FF6B6B')(' Bundle Buy (JITO)'));
  console.log(chalk.yellow('2:') + chalk.hex('#4ECDC4')(' Auto Volume'));
  console.log(chalk.yellow('3:') + chalk.hex('#45B7D1')(' Human Mode'));
  console.log(chalk.yellow('4:') + chalk.hex('#FF8C42')(' MicroBuy (SPAM)'));
  console.log(chalk.yellow('5:') + chalk.hex('#98D8C8')(' BumpBot'));
  console.log(chalk.yellow('6:') + chalk.hex('#F3A712')(' Warmup Mode'));
  console.log(chalk.yellow('7:') + chalk.hex('#064f8c')(' Stagger Buy'));
  console.log(chalk.yellow('8:') + chalk.hex('#FF4500')(' Human Buy')); 
  console.log(chalk.yellow('9:') + chalk.hex('#ADFF2F')(' Rapid Buy (Mode 2)'));
  console.log(chalk.yellow('10:') + chalk.hex('#C04CFD')(' Back to Main Menu'));
  const action = await promptUser('\n--> ');
  return action.toUpperCase();
}


// Sell menu
async function sellMenu() {
  console.clear();
  console.log(chalk.bgMagenta.black('\n=== Sell Modes ===\n'));
  console.log(chalk.yellow('1:') + chalk.hex('#FF6B6B')(' Sell All (JITO)'));
  console.log(chalk.yellow('2:') + chalk.hex('#4ECDC4')(' Single Wallet Sell'));
  console.log(chalk.yellow('3:') + chalk.hex('#FF8C42')(' Delay Sell'));
  console.log(chalk.yellow('4:') + chalk.hex('#45B7D1')(' Cleanup Mode'));
  console.log(chalk.yellow('5:') + chalk.hex('#C1D4H4')(' Ray Single Sell'));
  console.log(chalk.yellow('6:') + chalk.hex('#FFD700')(' Multiple Wallet Sell')); // New option added
  console.log(chalk.yellow('10:') + chalk.hex('#00FF00')(' Multi Wallet Timed Sell')); // New option added
  console.log(chalk.yellow('7:') + chalk.hex('#C04CFD')(' Back to Main Menu'));
  const action = await promptUser('\n--> ');
  return action.toUpperCase();
}
async function walletMenu() {
  console.clear();
  console.log(chalk.bgGreen.black('\n=== Wallets ===\n'));
  console.log(chalk.yellow('1:') + chalk.hex('#6A5ACD')(' Gen Wallets'));
  console.log(chalk.yellow('2:') + chalk.hex('#4ECDC4')(' Check Balances'));
  console.log(chalk.yellow('3:') + chalk.hex('#45B7D1')(' Close Token Accounts'));
  console.log(chalk.yellow('4:') + chalk.hex('#FF8C42')(' Create Profiles'));
  console.log(chalk.yellow('5:') + chalk.hex('#C04CFD')(' Unwrap WSOL'));
  console.log(chalk.yellow('6:') + chalk.hex('#4CAF50')(' Set Buy Amounts'));
  console.log(chalk.yellow('7:') + chalk.hex('#FF0000')(' Back to Main Menu'));
  const action = await promptUser('\n--> ');
  return action.toUpperCase();
}

async function transferMenu() {
  console.clear();
  console.log(chalk.bgYellow.black('\n=== Transfer ===\n'));
  console.log(chalk.blue('1:') + chalk.hex('#FF6B6B')(' Send to Volume Wallets'));
  console.log(chalk.blue('2:') + chalk.hex('#4ECDC4')(' Return to Main Wallet'));
  console.log(chalk.blue('3:') + chalk.hex('#45B7D1')(' Transfer SPL to Main Wallet'));
  console.log(chalk.blue('4:') + chalk.hex('#C04CFD')(' Back to Main Menu'));
  const action = await promptUser('\n--> ');
  return action.toUpperCase();
}

// Main action dispatcher
async function handleAction(action) {
  switch (action) {
    case '1':
      await handleBuyMenu();
      return;
    case '2':
      await handleSellMenu();
      return;
    case '3':
      await handleWalletMenu();
      return;
    case '4':
      await handleTransferMenu();
      return;
    case 'Q':
      console.log(chalk.red("Goodbye"));
      process.exit(0);
    default:
      console.log(chalk.red("Invalid input, please try again."));
  }
}

// Buy menu actions (unchanged except for proper parsing of delays)
async function handleBuyMenu() {
  const action = await buyMenu();
  switch (action) {
    case '1': {
      const mint = await promptUser("Enter Token CA: ");
      const delay = await promptUser("Enter delay in ms (1s = 1000): ");
      console.log(chalk.green(`Generating Volume for ${mint}`));
      await buyThePumpJito(mint, delay);
      break;
    }
    case '2': {
      const autoMinDelay = await promptUser("Enter min delay in milliseconds: ");
      const autoMaxDelay = await promptUser("Enter max delay in milliseconds: ");
      const autoSellPct = await promptUser("Enter sell percentage (0 - 100): ");
      console.log(chalk.blue("Starting Wallet Monitor, please launch a token after you see this message!"));
      await walletTracker(autoMinDelay, autoMaxDelay, autoSellPct);
      break;
    }
    case '3': {
      const token = await promptUser("Enter Token CA: ");
      const minDelay = await promptUser("Enter min delay in milliseconds: ");
      const maxDelay = await promptUser("Enter max delay in milliseconds: ");
      const humanSellPct = await promptUser("Enter sell percentage (0 - 100): ");
      console.log("\n");
      await humanMode(token, minDelay, maxDelay, humanSellPct);
      break;
    }
    case '4': {
      const tokenCA = await promptUser("Enter Token CA: ");
      const delayMS = await promptUser("Enter delay in ms (1s = 1000): ");
      await microBuySpam(tokenCA, delayMS);
      break;
    }
    case '5': {
      const t = await promptUser("Enter Token CA: ");
      const buyAmt = await promptUser("Enter Buy Amount: ");
      const d = await promptUser("Enter delay in ms (1s = 1000): ");
      await buyAndSell(t, buyAmt, d, rl);
      rl.removeAllListeners('line');
      break;
    }
    case '6': {
      const loops = await promptUser("Enter number of loops: ");
      const warmupDelay = await promptUser("Enter delay in ms (1s = 1000): ");
      await warmupWallets(loops, warmupDelay);
      break;
    }
    case '7': {
      // Stagger Buy mode with min and max delay
      const staggerCA = await promptUser("Enter Token CA: ");
      const staggerDelay = await promptUser("Enter min delay in ms (1s = 1000): ");
      const staggerMaxDelay = await promptUser("Enter max delay in ms (1s = 1000): ");
      const staggerLoops = await promptUser("Enter number of loops: ");
      const useJito = await promptUser("Use JITO (y/n): ");
      if (useJito.toUpperCase() === 'Y') {
        await staggerBuy(
          staggerCA,
          parseInt(staggerDelay),
          parseInt(staggerMaxDelay),
          parseInt(staggerLoops),
          true
        );
      } else {
        await staggerBuy(
          staggerCA,
          parseInt(staggerDelay),
          parseInt(staggerMaxDelay),
          parseInt(staggerLoops),
          false
        );
      }
      break;
    }
    case '8': {
      const tokenCA = await promptUser("Enter Token CA: ");
      
      // Prompt for wallet selection method
      console.log(chalk.cyan("\nWallet Selection Options:"));
      console.log(chalk.yellow("1:") + " Select number of random wallets");
      console.log(chalk.yellow("2:") + " Select specific wallets by index");
      
      const selectionMethod = await promptUser("\nEnter your choice (1 or 2): ");
      
      let walletSelection;
      
      if (selectionMethod === "1") {
          // Random wallets selection
          const numWalletsInput = await promptUser("Enter number of wallets to use: ");
          const numWallets = parseInt(numWalletsInput);
          
          if (isNaN(numWallets) || numWallets < 1) {
              console.log(chalk.red("Invalid number of wallets. Using 1 wallet."));
              walletSelection = { type: "random", count: 1 };
          } else {
              walletSelection = { type: "random", count: numWallets };
          }
      } else if (selectionMethod === "2") {
          // Specific wallets selection
          console.log(chalk.cyan("\nEnter wallet numbers separated by commas (e.g., 1,3,5)"));
          console.log(chalk.cyan("Note: Wallets are 1-indexed (first wallet is 1, not 0)"));
          
          const walletIndicesInput = await promptUser("Enter wallet indices: ");
          const walletIndices = walletIndicesInput.split(",")
              .map(idx => idx.trim())
              .filter(idx => idx !== "")
              .map(idx => parseInt(idx));
          
          if (walletIndices.length === 0 || walletIndices.some(idx => isNaN(idx) || idx < 1)) {
              console.log(chalk.red("Invalid wallet selection. Using wallet #1."));
              walletSelection = { type: "specific", indices: [1] };
          } else {
              walletSelection = { type: "specific", indices: walletIndices };
          }
      } else {
          console.log(chalk.red("Invalid selection method. Using 1 random wallet."));
          walletSelection = { type: "random", count: 1 };
      }
      
      // Prompt for delays
      const maxDelay = parseInt(await promptUser("Enter maximum delay in milliseconds: "));
      const minDelay = parseInt(await promptUser("Enter minimum delay in milliseconds: "));
      
      if (isNaN(maxDelay) || isNaN(minDelay) || maxDelay < 0 || minDelay < 0 || minDelay > maxDelay) {
          console.log(chalk.red("Invalid delay values. Using defaults of 10000ms max, 5000ms min."));
          maxDelay = 10000;
          minDelay = 5000;
      }
      
      // Start humanbuy process
      console.log(chalk.green(`Starting Human Buy for ${tokenCA}`));
      if (walletSelection.type === "random") {
          console.log(chalk.green(`Using ${walletSelection.count} random wallets`));
      } else {
          console.log(chalk.green(`Using specific wallets: ${walletSelection.indices.join(", ")}`));
      }
      console.log(chalk.green(`Delays: ${maxDelay}ms max to ${minDelay}ms min`));
      
      await humanbuy(tokenCA, walletSelection, maxDelay, minDelay);
      break;
  }
    case '9': {
      const tokenCA = await promptUser("Enter Token CA: ");
      await rapidBuyMode2(tokenCA, rl);
      break;
    }
    case '10':
      return; // Back to Main Menu
    default:
      console.log(chalk.red("Invalid input, please try again."));
      await handleBuyMenu();
  }
}


// Sell menu actions
async function handleSellMenu() {
  const action = await sellMenu();
  switch (action) {
    case '1': {
      const mint = await promptUser("Enter Token CA: ");
      const percent = await promptUser("Enter percentage to sell (1 - 100): ");
      await sellTheDump(mint, percent);
      break;
    }
    case '2': {
      const token = await promptUser("Enter Token CA: ");
      await singleSell(token, rl);
      break;
    }
    case '3': {
      const ca = await promptUser("Enter Token CA: ");
      const delay = await promptUser("Enter delay in ms (1s = 1000): ");
      await delaySell(ca, delay);
      break;
    }
    case '4': {
      console.log(chalk.blue("Starting Cleanup Mode, this will sell ALL PF tokens from your sub wallets!"));
      await cleanup();
      break;
    }
    case '5': {
      const tokenCA = await promptUser("Enter Token CA: ");
      const rayPercent = await promptUser("Enter percentage to sell (1 - 100): ");
      await raySell(tokenCA, parseInt(rayPercent));
      break;
    }
    case '6': {
      const tokenCA = await promptUser("Enter Token CA: ");
      await multipleSell(tokenCA, rl);
      break;
    }
    case '10': {
      const tokenCA = await promptUser("Enter Token CA: ");
      await multiTimedSell(tokenCA, rl);
      break;
    }
    case '7':
      return; // Back to main menu
    default:
      console.log(chalk.red("Invalid input, please try again."));
      await handleSellMenu();
  }
}


// Wallet menu actions
async function handleWalletMenu() {
  const action = await walletMenu();
  switch (action) {
    case '1': {
      const amount = await promptUser("Enter amount of wallets to generate: ");
      await genWallet(amount);
      break;
    }
    case '2':
      await checkBalances();
      break;
    case '3':
      await closeTokenAccounts();
      break;
    case '4':
      await createPumpProfiles();
      break;
    case '5':
      await unwrapWSOL();
      break;
    case '6':
      await promptBuyAmounts();
      break;
    case '7':
      return; // Back to main menu
    default:
      console.log(chalk.red("Invalid input, please try again."));
      await handleWalletMenu();
  }
}

// Transfer menu actions
async function handleTransferMenu() {
  const action = await transferMenu();
  switch (action) {
    case '1':
      await distro();
      break;
    case '2':
      console.log(chalk.blue("Returning all SOL to dev wallet..."));
      await refund();
      break;
    case '3': {
      const mint = await promptUser("Enter Token CA: ");
      const recieveWallet = await promptUser("Enter receiver wallet (public key): ");
      await sendSPL(mint, recieveWallet);
      break;
    }
    case '4':
      return; // Back to main menu
    default:
      console.log(chalk.red("Invalid input, please try again."));
      await handleTransferMenu();
  }
}

// Main loop
async function main() {
  while (true) {
    const action = await mainMenu();
    await handleAction(action);
  }
}

main().catch(console.error).finally(() => {
  rl.close();
});
