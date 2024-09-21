require('dotenv').config();
const ethers = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite3').verbose();

// Uniswap V2 ABIs
const UniswapV2Router = require('@uniswap/v2-periphery/build/UniswapV2Router02.json');
const UniswapV2Factory = require('@uniswap/v2-core/build/UniswapV2Factory.json');
const IERC20 = require('@uniswap/v2-core/build/IERC20.json');

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize Ethereum provider
const provider = new ethers.providers.JsonRpcProvider(process.env.HOLESKY_RPC_URL);

// Uniswap V2 contract addresses on Holesky testnet
const UNISWAP_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';

// Example token addresses on Holesky testnet (replace with actual token addresses)
const WETH_ADDRESS = '0xdA87DBE6813b8757Ec52fC4275E2D67d5e9e6D06';
const DAI_ADDRESS = '0xc1E1E89F2C8A7ccc7a3b7883e77361D9fB0B3842';

// Initialize Uniswap contracts
const uniswapRouter = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, UniswapV2Router.abi, provider);
const uniswapFactory = new ethers.Contract(UNISWAP_FACTORY_ADDRESS, UniswapV2Factory.abi, provider);

// Initialize SQLite database
let db;
open({
  filename: './database.sqlite',
  driver: sqlite3.Database
}).then((dbase) => {
  db = dbase;
  initializeDatabase();
}).catch((err) => {
  console.error('Error opening database', err);
});

// Helper functions
function formatEther(wei) {
  return parseFloat(ethers.utils.formatEther(wei)).toFixed(4);
}

function formatAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function createInlineKeyboard(buttons) {
  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

function sendNotification(chatId, message) {
  bot.sendMessage(chatId, `🔔 ${message}`);
}

// Function to initialize the database
function initializeDatabase() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE,
    wallet_address TEXT,
    encrypted_private_key TEXT,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS copy_trading (
    id INTEGER PRIMARY KEY,
    follower_id TEXT,
    followed_address TEXT,
    UNIQUE(follower_id, followed_address)
  )`);

  console.log('Database initialized');
}

// Function to save user data
async function saveUser(telegramId, walletAddress, encryptedPrivateKey, password) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO users (telegram_id, wallet_address, encrypted_private_key, password) VALUES (?, ?, ?, ?)',
      [telegramId, walletAddress, encryptedPrivateKey, password],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Function to get user data
async function getUser(telegramId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Function to save copy trading relationship
async function saveCopyTrading(followerId, followedAddress) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO copy_trading (follower_id, followed_address) VALUES (?, ?)',
      [followerId, followedAddress],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Function to remove copy trading relationship
async function removeCopyTrading(followerId, followedAddress) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM copy_trading WHERE follower_id = ? AND followed_address = ?',
      [followerId, followedAddress],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Function to get all copied addresses for a user
async function getCopiedAddresses(followerId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT followed_address FROM copy_trading WHERE follower_id = ?',
      [followerId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => row.followed_address));
      }
    );
  });
}

// Wallet and trading functions
function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

function encryptPrivateKey(privateKey, password) {
  const cipher = crypto.createCipher('aes-256-cbc', password);
  let encryptedKey = cipher.update(privateKey, 'utf-8', 'hex');
  encryptedKey += cipher.final('hex');
  return encryptedKey;
}

function decryptPrivateKey(encryptedKey, password) {
  const decipher = crypto.createDecipher('aes-256-cbc', password);
  let decryptedKey = decipher.update(encryptedKey, 'hex', 'utf-8');
  decryptedKey += decipher.final('utf-8');
  return decryptedKey;
}

async function getTokenBalance(tokenAddress, walletAddress) {
  const tokenContract = new ethers.Contract(tokenAddress, IERC20.abi, provider);
  const balance = await tokenContract.balanceOf(walletAddress);
  return formatEther(balance);
}

async function executeSwap(wallet, tokenIn, tokenOut, amountIn) {
  const signer = wallet.connect(provider);
  const routerWithSigner = uniswapRouter.connect(signer);

  // Approve the router to spend tokens
  const tokenContract = new ethers.Contract(tokenIn, IERC20.abi, signer);
  await tokenContract.approve(UNISWAP_ROUTER_ADDRESS, amountIn);

  // Execute the swap
  const tx = await routerWithSigner.swapExactTokensForTokens(
    amountIn,
    0, // Accept any amount of output tokens
    [tokenIn, tokenOut],
    wallet.address,
    Math.floor(Date.now() / 1000) + 60 * 20 // 20 minute deadline
  );

  return tx;
}

function startMonitoringAddress(address) {
  provider.on(address, (tx) => {
    handleTransaction(address, tx);
  });
}

// Bot commands with improved UI
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const message = 'Welcome to the Crypto Copy-Trading Bot! What would you like to do?';
  const options = createInlineKeyboard([
    [{ text: 'Set up wallet', callback_data: 'setup_wallet' }],
    [{ text: 'Check balance', callback_data: 'check_balance' }],
    [{ text: 'Copy trade', callback_data: 'copy_trade' }]
  ]);
  bot.sendMessage(chatId, message, options);
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const action = callbackQuery.data;

  switch (action) {
    case 'setup_wallet':
      await handleWalletSetup(chatId, userId);
      break;
    case 'check_balance':
      await handleBalanceCheck(chatId, userId);
      break;
    case 'copy_trade':
      await handleCopyTrade(chatId, userId);
      break;
    // Add more cases for other actions
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

async function handleWalletSetup(chatId, userId) {
  try {
    let user = await getUser(userId);
    
    if (user) {
      const message = `You already have a wallet set up. Your address is: ${formatAddress(user.wallet_address)}`;
      bot.sendMessage(chatId, message);
    } else {
      const newWallet = generateWallet();
      const password = crypto.randomBytes(32).toString('hex');
      const encryptedPrivateKey = encryptPrivateKey(newWallet.privateKey, password);
      
      await saveUser(userId, newWallet.address, encryptedPrivateKey, password);
      
      const message = `Your new wallet has been created. Your address is: ${formatAddress(newWallet.address)}`;
      bot.sendMessage(chatId, message);
      sendNotification(chatId, 'Wallet setup complete! Please keep your private key and password safe. Never share them with anyone.');
    }
  } catch (error) {
    console.error('Error in wallet setup:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error setting up your wallet. Please try again later.');
  }
}

async function handleBalanceCheck(chatId, userId) {
  try {
    const user = await getUser(userId);
    if (!user) {
      bot.sendMessage(chatId, 'Please set up your wallet first.');
      return;
    }
    
    const ethBalance = await provider.getBalance(user.wallet_address);
    const wethBalance = await getTokenBalance(WETH_ADDRESS, user.wallet_address);
    const daiBalance = await getTokenBalance(DAI_ADDRESS, user.wallet_address);
    
    const message = `Your wallet balances:\n` +
                    `ETH: ${formatEther(ethBalance)} ETH\n` +
                    `WETH: ${wethBalance} WETH\n` +
                    `DAI: ${daiBalance} DAI`;
    
    bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('Error fetching balance:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error fetching your balance. Please try again later.');
  }
}

async function handleCopyTrade(chatId, userId) {
  bot.sendMessage(chatId, 'Please enter the Ethereum address you want to copy trade from:');
  bot.once('message', async (msg) => {
    const addressToCopy = msg.text;
    if (!ethers.utils.isAddress(addressToCopy)) {
      bot.sendMessage(chatId, 'Invalid Ethereum address. Please provide a valid address to copy.');
      return;
    }
    
    try {
      await saveCopyTrading(userId, addressToCopy);
      startMonitoringAddress(addressToCopy);
      sendNotification(chatId, `You are now copying trades from ${formatAddress(addressToCopy)}`);
    } catch (error) {
      console.error('Error in copy trade setup:', error);
      bot.sendMessage(chatId, 'Sorry, there was an error setting up copy trading. Please try again later.');
    }
  });
}

bot.onText(/\/swap/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Please enter the swap details in the format: [tokenIn] [tokenOut] [amount]');
  bot.once('message', async (response) => {
    const [tokenIn, tokenOut, amount] = response.text.split(' ');
    await handleSwap(chatId, msg.from.id, tokenIn, tokenOut, amount);
  });
});

async function handleSwap(chatId, userId, tokenIn, tokenOut, amount) {
  try {
    const user = await getUser(userId);
    if (!user) {
      bot.sendMessage(chatId, 'Please set up your wallet first using /start.');
      return;
    }
    
    if (!tokenIn || !tokenOut || !amount) {
      bot.sendMessage(chatId, 'Invalid format. Please use: [tokenIn] [tokenOut] [amount]');
      return;
    }
    
    const privateKey = decryptPrivateKey(user.encrypted_private_key, user.password);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    const amountIn = ethers.utils.parseEther(amount);
    const tx = await executeSwap(wallet, tokenIn, tokenOut, amountIn);
    sendNotification(chatId, `Swap executed successfully. Transaction hash: ${tx.hash}`);
  } catch (error) {
    console.error('Error executing swap:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error executing the swap. Please try again later.');
  }
}

bot.onText(/\/listcopied/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const copiedAddresses = await getCopiedAddresses(userId);
    
    if (copiedAddresses.length === 0) {
      bot.sendMessage(chatId, 'You are not currently copying any addresses.');
    } else {
      const message = 'You are currently copying trades from:\n' + 
                      copiedAddresses.map(addr => formatAddress(addr)).join('\n');
      bot.sendMessage(chatId, message);
    }
  } catch (error) {
    console.error('Error in /listcopied command:', error);
    bot.sendMessage(chatId, 'Sorry, there was an error fetching your copied addresses. Please try again later.');
  }
});

// Function to handle a monitored transaction
async function handleTransaction(address, tx) {
    console.log(`New transaction from ${address}: ${tx.hash}`);
    
    // Check if the transaction is a Uniswap swap
    if (tx.to === UNISWAP_ROUTER_ADDRESS) {
      const transaction = await provider.getTransaction(tx.hash);
      const decodedInput = uniswapRouter.interface.parseTransaction({ data: transaction.data, value: transaction.value });
      
      if (decodedInput.name === 'swapExactTokensForTokens' || decodedInput.name === 'swapExactETHForTokens') {
        // Get all followers for this address
        const followers = await getCopiedAddresses(address);
        
        for (const followerId of followers) {
          try {
            const userSession = await getUser(followerId);
            const privateKey = decryptPrivateKey(userSession.encrypted_private_key, userSession.password);
            const wallet = new ethers.Wallet(privateKey, provider);
            
            // Adjust the amount based on the follower's balance and settings
            const adjustedAmount = calculateAdjustedAmount(decodedInput.args.amountIn, userSession);
            
            // Execute the swap for the follower
            const followerTx = await executeSwap(
              wallet,
              decodedInput.args.path[0],
              decodedInput.args.path[decodedInput.args.path.length - 1],
              adjustedAmount
            );
            
            console.log(`Replicated trade for follower ${followerId}: ${followerTx.hash}`);
            sendNotification(followerId, `Replicated trade from ${formatAddress(address)}. Transaction hash: ${followerTx.hash}`);
          } catch (error) {
            console.error(`Error replicating trade for follower ${followerId}:`, error);
            sendNotification(followerId, `Failed to replicate trade from ${formatAddress(address)}. Error: ${error.message}`);
          }
        }
      }
    }
  }
// Function to calculate adjusted amount for a follower
function calculateAdjustedAmount(originalAmount, userSession) {
    // Implement your logic to adjust the amount based on the follower's balance and settings
    // This is a simple example that uses a fixed percentage
    const COPY_PERCENTAGE = 0.1; // 10% of the original trade
    return originalAmount.mul(ethers.BigNumber.from(COPY_PERCENTAGE * 100)).div(100);
  }
  
  // Function to start monitoring addresses
  async function startMonitoringAllAddresses() {
    try {
      const allCopyTradingData = await db.all('SELECT DISTINCT followed_address FROM copy_trading');
      for (const row of allCopyTradingData) {
        startMonitoringAddress(row.followed_address);
      }
      console.log('Started monitoring all copied addresses');
    } catch (error) {
      console.error('Error starting to monitor addresses:', error);
    }
  }
  
  // Start the bot and initialize monitoring
  initializeDatabase()
    .then(() => {
      console.log('Database initialized');
      return startMonitoringAllAddresses();
    })
    .then(() => {
      console.log('Crypto Copy-Trading Bot is now running...');
    })
    .catch((error) => {
      console.error('Error during initialization:', error);
    });