// Configuration
let TOTAL_SQUARES = null; // Will be read from contract on page load
const MARGIN_HEIGHT = 30; // Fixed 30px top and bottom margins
const GRID_COLOR = '#e0e0e0'; // Thin grey for grid lines
const GRID_LINE_WIDTH = 0.5;
const SQUARES_PER_FRAME = 3; // Speed of animation (reduced for smoother effect)

// Subgraph Configuration (update URL when deploying mainnet subgraph)
const SUBGRAPH_URL = 'https://subgraph.satsuma-prod.com/64e5e72824d3/figure31--8074/bluemoon-subgraph/api';
const POLL_INTERVAL = 15000; // 15 seconds

// ============================================
// ⭐ DEPLOYMENT CONFIGURATION ⭐
// ============================================
// When deploying to mainnet, change BOTH values below:
// 1. Set NETWORK to 'mainnet'
// 2. Update BLUEMOON_CONTRACT to mainnet address
// ============================================

const NETWORK = 'testnet'; // 'testnet' or 'mainnet'

// Network configurations
const NETWORKS = {
    testnet: {
        chainId: 84532,
        rpc: 'https://sepolia.base.org',
        name: 'Base Sepolia Testnet',
        explorer: 'https://sepolia.basescan.org'
    },
    mainnet: {
        chainId: 8453,
        rpc: 'https://mainnet.base.org',
        name: 'Base Mainnet',
        explorer: 'https://basescan.org'
    }
};

// Get current network config
const CURRENT_NETWORK = NETWORKS[NETWORK];
const BASE_CHAIN_ID = CURRENT_NETWORK.chainId;
const BASE_RPC = CURRENT_NETWORK.rpc;

// BlueMoon Contract Address (change for mainnet deployment)
const BLUEMOON_CONTRACT = '0xA07c1b9eb264D6A898B9e7dAB1F4Fd01e0A12a71';

// BlueMoon NFT Contract Address (Base Sepolia testnet)
const BLUEMOON_NFT_CONTRACT = '0x0ec66b8E25Cb3e6C8D83B95873a6EF455e5780c9';

// ERC20 ABI for token interactions
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

// BlueMoon Contract ABI (only functions we need)
const BLUEMOON_ABI = [
    'function mint(uint256 amount)',
    'function MINT_PRICE() view returns (uint256)',
    'function TOKENS_PER_MINT() view returns (uint256)',
    'function MAX_MINTS() view returns (uint256)',
    'function MAX_MINTS_PER_ADDRESS() view returns (uint256)',
    'function mintsByAddress(address) view returns (uint256)',
    'function usdc() view returns (address)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'event ColorMinted(address indexed minter, uint256 indexed mintId, uint256 hue, uint256 saturation, uint256 lightness, string color)'
];

// BlueMoon NFT Contract ABI (for viewing and minting NFTs)
const BLUEMOON_NFT_ABI = [
    'function totalMinted() view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function TOTAL_SUPPLY() view returns (uint256)',
    'function ARTIST_PROOFS() view returns (uint256)',
    'function blueToken() view returns (address)',
    'function mint()'
];

// Dynamic values read from contract (initialized on page load)
let USDC_CONTRACT = null;
let MINT_PRICE_USDC = null;
let TOKENS_PER_MINT = null;
let MAX_MINT_LIMIT = null;
let MAX_USDC_APPROVAL = null;
let TOKEN_SYMBOL = null;
let TOTAL_SUPPLY = null;

// Wallet state
let provider = null;
let signer = null;
let userAddress = null;
let isWalletConnected = false;

// ============================================
// SUBGRAPH QUERIES
// ============================================

/**
 * Execute GraphQL query against subgraph
 */
async function querySubgraph(query, variables = {}) {
    try {
        const response = await fetch(SUBGRAPH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.errors) {
            console.error('GraphQL errors:', result.errors);
            throw new Error(result.errors[0].message);
        }

        return result.data;
    } catch (error) {
        console.error('Subgraph query failed:', error);
        return null;
    }
}

/**
 * Get global statistics
 */
async function getGlobalStats() {
    const query = `
        query GetGlobalStats {
            globalStats(id: "1") {
                totalTokensMinted
                remainingTokens
                totalUSDCCollected
                uniqueMinters
                totalMintTransactions
                totalColorsMinted
                maxMints
            }
        }
    `;

    const data = await querySubgraph(query);
    return data?.globalStats || null;
}

/**
 * Get all colors (paginated)
 */
async function getAllColors() {
    const allColors = [];
    const batchSize = 1000;

    for (let skip = 0; skip < TOTAL_SQUARES; skip += batchSize) {
        const query = `
            query GetColors($skip: Int!, $first: Int!) {
                colors(
                    first: $first,
                    skip: $skip,
                    orderBy: mintId,
                    orderDirection: asc
                ) {
                    mintId
                    color
                    hue
                    saturation
                    lightness
                    minter
                    timestamp
                }
            }
        `;

        const data = await querySubgraph(query, { skip, first: batchSize });

        if (!data || !data.colors) break;

        allColors.push(...data.colors);

        // If we got fewer than batchSize, we've reached the end
        if (data.colors.length < batchSize) break;
    }

    return allColors;
}

/**
 * Get recent mint transactions for activity feed
 */
async function getRecentTransactions() {
    const query = `
        query GetRecentActivity {
            mintTransactions(
                first: 10,
                orderBy: timestamp,
                orderDirection: desc
            ) {
                id
                minter
                amount
                timestamp
                blockNumber
            }
        }
    `;

    const data = await querySubgraph(query);
    return data?.mintTransactions || [];
}

/**
 * Get user stats from subgraph
 */
async function getUserStats(address) {
    if (!address) return null;

    const query = `
        query GetUserStats($address: String!) {
            user(id: $address) {
                address
                totalBlueMinted
                totalMintTransactions
                mintIds
                firstMintTimestamp
                lastMintTimestamp
            }
        }
    `;

    const data = await querySubgraph(query, { address: address.toLowerCase() });
    return data?.user || null;
}

// ============================================
// CONTRACT INITIALIZATION
// ============================================

/**
 * Initialize dynamic contract values by reading from BlueMoon contract
 * This makes the code deployment-ready - only need to change BLUEMOON_CONTRACT address
 * Values are cached in localStorage for faster subsequent loads
 */
async function initializeContractValues() {
    try {

        // Cache key includes contract address to invalidate cache if contract changes
        const cacheKey = `bluemoon_config_${BLUEMOON_CONTRACT.toLowerCase()}`;

        // Try to load from cache first
        const cachedConfig = localStorage.getItem(cacheKey);
        if (cachedConfig) {
            try {
                const config = JSON.parse(cachedConfig);

                // Validate cache has all required fields (invalidate old cache)
                if (!config.tokenSymbol || !config.totalSupply || !config.maxMints) {
                    localStorage.removeItem(cacheKey);
                } else {
                    USDC_CONTRACT = config.usdcContract;
                    MINT_PRICE_USDC = config.mintPrice;
                    TOKENS_PER_MINT = config.tokensPerMint;
                    MAX_MINT_LIMIT = config.maxMintLimit;
                    MAX_USDC_APPROVAL = ethers.BigNumber.from(config.maxUsdcApproval);
                    TOKEN_SYMBOL = config.tokenSymbol;
                    TOTAL_SUPPLY = config.totalSupply;
                    TOTAL_SQUARES = config.maxMints;


                    return true;
                }
            } catch (e) {
            }
        }

        // Create a read-only provider (doesn't require wallet connection)
        const readProvider = new ethers.providers.JsonRpcProvider(BASE_RPC);
        const blueMoonContract = new ethers.Contract(BLUEMOON_CONTRACT, BLUEMOON_ABI, readProvider);

        // Read token symbol from contract
        TOKEN_SYMBOL = await blueMoonContract.symbol();

        // Read total supply from contract
        const totalSupplyFromContract = await blueMoonContract.totalSupply();
        TOTAL_SUPPLY = Math.floor(parseFloat(ethers.utils.formatUnits(totalSupplyFromContract, 18)));

        // Read USDC contract address from BlueMoon contract
        USDC_CONTRACT = await blueMoonContract.usdc();

        // Update USDC contract link in about page
        updateUSDCLink();

        // Read mint price from contract (returns value in 6 decimals for USDC)
        const mintPriceFromContract = await blueMoonContract.MINT_PRICE();
        MINT_PRICE_USDC = mintPriceFromContract.toString();

        // Read max mints per address from contract (this is NUMBER OF MINTS, not tokens)
        const maxMintsFromContract = await blueMoonContract.MAX_MINTS_PER_ADDRESS();
        const maxMintsPerAddress = maxMintsFromContract.toNumber();

        // Read tokens per mint
        const tokensPerMintFromContract = await blueMoonContract.TOKENS_PER_MINT();
        TOKENS_PER_MINT = Math.floor(parseFloat(ethers.utils.formatUnits(tokensPerMintFromContract, 18)));

        // Calculate max tokens (for display purposes)
        MAX_MINT_LIMIT = TOKENS_PER_MINT * maxMintsPerAddress;

        // Calculate max USDC approval needed (MINT_PRICE × number of mints)
        MAX_USDC_APPROVAL = ethers.BigNumber.from(MINT_PRICE_USDC).mul(maxMintsPerAddress);

        // Read MAX_MINTS from contract (total number of lots in the artwork)
        const totalMaxMintsFromContract = await blueMoonContract.MAX_MINTS();
        TOTAL_SQUARES = totalMaxMintsFromContract.toNumber();

        // Cache the configuration
        const configToCache = {
            tokenSymbol: TOKEN_SYMBOL,
            totalSupply: TOTAL_SUPPLY,
            maxMints: TOTAL_SQUARES,
            usdcContract: USDC_CONTRACT,
            mintPrice: MINT_PRICE_USDC,
            tokensPerMint: TOKENS_PER_MINT,
            maxMintLimit: MAX_MINT_LIMIT,
            maxUsdcApproval: MAX_USDC_APPROVAL.toString()
        };
        localStorage.setItem(cacheKey, JSON.stringify(configToCache));

        return true;
    } catch (error) {
        console.error('❌ Failed to initialize contract values:', error);
        alert('Failed to load contract configuration. Please refresh the page.');
        return false;
    }
}

/**
 * Update mint button amounts and prices dynamically
 */
function updateMintButtonPrices() {
    if (!MINT_PRICE_USDC || !TOKENS_PER_MINT) return;

    const price1 = ethers.utils.formatUnits(MINT_PRICE_USDC, 6);
    const price8 = ethers.utils.formatUnits(ethers.BigNumber.from(MINT_PRICE_USDC).mul(8), 6);

    const tokens1 = TOKENS_PER_MINT;
    const tokens8 = TOKENS_PER_MINT * 8;

    // Update button text with new format
    const mint1Amount = document.querySelector('#mint-1-btn .mint-amount');
    const mint1Cost = document.querySelector('#mint-1-btn .mint-cost');
    const mint8Amount = document.querySelector('#mint-8-btn .mint-amount');
    const mint8Cost = document.querySelector('#mint-8-btn .mint-cost');

    if (mint1Amount) mint1Amount.textContent = `${tokens1.toLocaleString()} $${TOKEN_SYMBOL || 'BLUE'}`;
    if (mint1Cost) mint1Cost.textContent = `${price1} usdc`;
    if (mint8Amount) mint8Amount.textContent = `${tokens8.toLocaleString()} $${TOKEN_SYMBOL || 'BLUE'}`;
    if (mint8Cost) mint8Cost.textContent = `${price8} usdc`;
}

/**
 * Update max USDC approval amount dynamically
 */
function updateMaxUSDCApproval() {
    if (!MAX_USDC_APPROVAL) return;

    const maxUsdcApprovalElement = document.getElementById('max-usdc-approval');
    if (!maxUsdcApprovalElement) return;

    // Format USDC amount (6 decimals) with comma separators
    const maxUsdcFormatted = parseFloat(ethers.utils.formatUnits(MAX_USDC_APPROVAL, 6)).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

    maxUsdcApprovalElement.textContent = maxUsdcFormatted;
}

// ============================================
// WALLET CONNECTION
// ============================================

/**
 * Check if user is on correct Base network
 */
async function checkNetwork() {
    if (!provider) return false;

    try {
        const network = await provider.getNetwork();
        return network.chainId === BASE_CHAIN_ID;
    } catch (error) {
        console.error('Error checking network:', error);
        return false;
    }
}

/**
 * Prompt user to switch to Base network (testnet or mainnet)
 */
async function switchToBaseSepolia() {
    if (!window.ethereum) return false;

    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${BASE_CHAIN_ID.toString(16)}` }],
        });
        return true;
    } catch (switchError) {
        // This error code indicates that the chain has not been added to the wallet
        if (switchError.code === 4902) {
            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
                        chainName: CURRENT_NETWORK.name,
                        nativeCurrency: {
                            name: 'Ethereum',
                            symbol: 'ETH',
                            decimals: 18
                        },
                        rpcUrls: [BASE_RPC],
                        blockExplorerUrls: [CURRENT_NETWORK.explorer]
                    }],
                });
                return true;
            } catch (addError) {
                console.error('Error adding network:', addError);
                return false;
            }
        }
        console.error('Error switching network:', switchError);
        return false;
    }
}

/**
 * Get user's BLUE token balance from contract
 */
async function getBLUEBalance(address) {
    if (!provider || !address) return '0';

    try {
        const blueContract = new ethers.Contract(BLUEMOON_CONTRACT, ERC20_ABI, provider);
        const balance = await blueContract.balanceOf(address);
        // Convert from wei (18 decimals) to tokens
        return ethers.utils.formatUnits(balance, 18);
    } catch (error) {
        console.error('Error getting BLUE balance:', error);
        return '0';
    }
}

/**
 * Get user's USDC balance from contract
 */
async function getUSDCBalance(address) {
    if (!provider || !address) return '0';

    try {
        const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
        const balance = await usdcContract.balanceOf(address);
        // Convert from 6 decimals to readable format
        return ethers.utils.formatUnits(balance, 6);
    } catch (error) {
        console.error('Error getting USDC balance:', error);
        return '0';
    }
}

/**
 * Update wallet UI with user data
 */
async function updateWalletUI() {
    const isMobile = window.innerWidth <= 768;
    const mintedSuffix = isMobile ? '' : ' minted';

    if (!userAddress) {
        walletInfo.classList.remove('connected');
        walletMinted.textContent = `0 $${TOKEN_SYMBOL || 'BLUE'}${mintedSuffix}`;
        walletUsdc.textContent = '0 USDC';
        walletAddress.textContent = '0x0000...0000';
        highlightBtn.style.display = 'none';
        cachedUserStats = null;
        return;
    }

    // Show wallet info
    walletInfo.classList.add('connected');
    walletAddress.textContent = formatAddress(userAddress);

    // Get user stats from subgraph
    const userStats = await getUserStats(userAddress);

    // Cache user stats for mint modal display
    cachedUserStats = userStats;

    // Get USDC balance from contract
    const usdcBalance = await getUSDCBalance(userAddress);

    // Update UI - minted amount from subgraph, USDC from contract
    const blueMinted = userStats ? Math.floor(parseInt(userStats.totalBlueMinted) / 1e18) : 0;
    walletMinted.textContent = `${blueMinted.toLocaleString()} $${TOKEN_SYMBOL || 'BLUE'}${mintedSuffix}`;
    walletUsdc.textContent = `${parseFloat(usdcBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;

    // Store user's mintIds for highlight feature
    if (userStats && userStats.mintIds && userStats.mintIds.length > 0) {
        userMintIds = userStats.mintIds.map(id => parseInt(id));
        highlightBtn.style.display = 'inline-block';
    } else {
        userMintIds = [];
        highlightBtn.style.display = 'none';
    }

}

/**
 * Connect wallet
 */
async function connectWallet() {
    // Check if ethers is loaded
    if (typeof ethers === 'undefined') {
        console.error('❌ ethers.js not loaded');
        alert('Loading error. Please refresh the page.');
        return false;
    }

    // Check if wallet is available
    if (!window.ethereum) {
        console.error('❌ No window.ethereum detected');
        alert('No Ethereum wallet detected. Please install MetaMask, Rabby, or another Ethereum wallet.');
        return false;
    }

    try {
        // Request account access
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

        if (!accounts || accounts.length === 0) {
            console.error('❌ No accounts returned');
            alert('No accounts found. Please unlock your wallet.');
            return false;
        }

        // Set up provider and signer
        provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();
        userAddress = accounts[0];

        // Check if on correct network
        const isCorrectNetwork = await checkNetwork();

        if (!isCorrectNetwork) {
            console.log('⚠️ Wrong network - switching to', CURRENT_NETWORK.name);
            const switched = await switchToBaseSepolia();
            if (!switched) {
                console.error('❌ User rejected network switch');
                alert(`Please switch to ${CURRENT_NETWORK.name} to use this app.`);
                // Reset connection
                provider = null;
                signer = null;
                userAddress = null;
                return false;
            }
            console.log('✅ Switched to', CURRENT_NETWORK.name);
        }

        // Mark as connected
        isWalletConnected = true;
        connectBtn.textContent = 'connected';
        connectBtn.classList.add('connected');

        // Update wallet UI
        await updateWalletUI();

        return true;
    } catch (error) {
        console.error('❌ Error connecting wallet:', error);
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            code: error.code
        });

        // More specific error messages
        if (error.code === 4001) {
            alert('Connection rejected. Please try again and approve the connection.');
        } else if (error.code === -32002) {
            alert('Connection request already pending. Please check your wallet.');
        } else {
            alert(`Failed to connect wallet: ${error.message}`);
        }
        return false;
    }
}

/**
 * Handle account changes
 */
if (window.ethereum) {
    window.ethereum.on('accountsChanged', async (accounts) => {
        if (accounts.length === 0) {
            // User disconnected wallet
            isWalletConnected = false;
            userAddress = null;
            provider = null;
            signer = null;
            userMintIds = [];
            cachedUserStats = null;
            connectBtn.textContent = 'connect';
            connectBtn.classList.remove('connected');

            // Exit highlight mode and show all colors
            if (isHighlightMode) {
                isHighlightMode = false;
                redrawCanvas(null);
            }

            await updateWalletUI();
        } else {
            // User switched accounts
            userAddress = accounts[0];

            // Exit highlight mode when switching accounts
            if (isHighlightMode) {
                isHighlightMode = false;
                highlightBtn.textContent = 'highlight';
                redrawCanvas(null);
            }

            await updateWalletUI();
        }
    });

    window.ethereum.on('chainChanged', async (chainId) => {
        // Reload page on network change (recommended by MetaMask)
        window.location.reload();
    });
}

// ============================================
// MINTING FUNCTIONS
// ============================================

/**
 * Check USDC allowance for BlueMoon contract
 */
async function checkUSDCAllowance(amount) {
    if (!provider || !userAddress) return false;

    try {
        const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
        const allowance = await usdcContract.allowance(userAddress, BLUEMOON_CONTRACT);

        return allowance.gte(ethers.BigNumber.from(amount));
    } catch (error) {
        console.error('Error checking allowance:', error);
        return false;
    }
}

/**
 * Approve USDC spending
 */
async function approveUSDC(amount) {
    if (!signer || !userAddress) {
        throw new Error('Wallet not connected');
    }

    try {
        mintStatus.textContent = 'Approving USDC spending...';

        const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, signer);

        // Approve max mint limit amount (3,555,556 tokens × 0.00088 USDC = ~3,128.89 USDC)
        const approvalAmount = MAX_USDC_APPROVAL;

        const tx = await usdcContract.approve(BLUEMOON_CONTRACT, approvalAmount);
        mintStatus.textContent = 'Waiting for approval confirmation...';

        await tx.wait();
        mintStatus.textContent = 'USDC approved!';

        console.log('Transaction hash:', tx.hash);
        return true;
    } catch (error) {
        console.error('Approval failed:', error);

        // User rejected transaction
        if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
            mintStatus.textContent = 'user rejected approval';
        }
        // Insufficient ETH for gas
        else if (error.code === 'INSUFFICIENT_FUNDS' || error.code === -32000) {
            mintStatus.textContent = 'insufficient ETH for gas';
        }
        // Generic approval failure
        else {
            mintStatus.textContent = 'approval failed';
        }

        throw error;
    }
}

/**
 * Execute mint transaction
 */
async function executeMint(amount) {
    if (!signer || !userAddress) {
        throw new Error('Wallet not connected');
    }

    try {
        const blueMoonContract = new ethers.Contract(BLUEMOON_CONTRACT, BLUEMOON_ABI, signer);

        // Calculate token amount for display
        const tokenAmount = TOKENS_PER_MINT ? (amount * TOKENS_PER_MINT).toLocaleString() : amount;

        mintStatus.textContent = `minting ${tokenAmount} $${TOKEN_SYMBOL || 'BLUE'}...`;

        const tx = await blueMoonContract.mint(amount);
        mintStatus.textContent = 'waiting for confirmation...';

        console.log('Transaction hash:', tx.hash);

        const receipt = await tx.wait();

        mintStatus.textContent = `successfully minted ${tokenAmount} $${TOKEN_SYMBOL || 'BLUE'}!`;
        console.log('Transaction hash:', receipt.transactionHash);

        // Refresh data after mint (don't auto-close modal)
        refreshData();

        return receipt;
    } catch (error) {
        console.error('Mint failed:', error);

        // User rejected transaction
        if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
            mintStatus.textContent = 'user rejected transaction';
        }
        // Insufficient ETH for gas
        else if (error.code === 'INSUFFICIENT_FUNDS' || error.code === -32000) {
            mintStatus.textContent = 'insufficient ETH for gas';
        }
        // Contract-specific errors (check error message)
        else if (error.message) {
            if (error.message.includes('One mint per block')) {
                mintStatus.textContent = 'wait for next block (~2 sec)';
            } else if (error.message.includes('Address mint limit reached')) {
                mintStatus.textContent = 'address mint limit reached';
            } else if (error.message.includes('Sold out')) {
                mintStatus.textContent = 'sold out';
            } else if (error.message.includes('USDC transfer failed')) {
                mintStatus.textContent = 'USDC transfer failed - check approval';
            } else if (error.message.includes('insufficient allowance')) {
                mintStatus.textContent = 'insufficient USDC allowance';
            } else if (error.message.includes('Must mint 1 or 8')) {
                mintStatus.textContent = 'invalid mint amount';
            } else {
                mintStatus.textContent = 'transaction failed';
            }
        } else {
            mintStatus.textContent = 'transaction failed';
        }

        throw error;
    }
}

/**
 * Handle mint button click
 */
async function handleMint(amount) {
    if (!isWalletConnected || !userAddress) {
        alert('Please connect your wallet first');
        return;
    }

    // Clear any previous status messages
    mintStatus.textContent = '';

    // Check network
    const isCorrectNetwork = await checkNetwork();
    if (!isCorrectNetwork) {
        alert(`Please switch to ${CURRENT_NETWORK.name}`);
        return;
    }

    try {
        // Calculate required USDC amount
        const requiredAmount = ethers.BigNumber.from(MINT_PRICE_USDC).mul(amount);

        // Check USDC balance
        const usdcBalance = await getUSDCBalance(userAddress);
        const usdcBalanceWei = ethers.utils.parseUnits(usdcBalance, 6);

        if (usdcBalanceWei.lt(requiredAmount)) {
            mintStatus.textContent = 'insufficient USDC balance';
            return;
        }

        // Check allowance
        const hasAllowance = await checkUSDCAllowance(requiredAmount);

        if (!hasAllowance) {
            await approveUSDC(requiredAmount);
        }

        // Execute mint
        await executeMint(amount);

    } catch (error) {
        console.error('Mint process failed:', error);
        // Error message already set in individual functions
    }
}

/**
 * Open mint modal
 */
function openMintModal() {
    if (!isWalletConnected || !userAddress) {
        alert('Please connect your wallet first');
        return;
    }

    // Update mint button prices (in case they weren't set yet)
    updateMintButtonPrices();

    // Update mint limit display
    updateMintLimitDisplay();

    // Show modal
    mintModal.classList.add('active');
    mintStatus.textContent = '';
}

/**
 * Close mint modal
 */
function closeMintModal() {
    mintModal.classList.remove('active');
    mintStatus.textContent = '';
}

// Store latest user stats to avoid duplicate queries
let cachedUserStats = null;

/**
 * Update mint limit display (uses cached user stats from updateWalletUI)
 */
function updateMintLimitDisplay() {
    if (!MAX_MINT_LIMIT) {
        mintLimitDisplay.textContent = 'Loading...';
        return;
    }

    const isMobile = window.innerWidth <= 768;
    const suffix = isMobile ? '' : ' max tokens minted';

    if (!userAddress || !cachedUserStats) {
        mintLimitDisplay.textContent = `0 / ${MAX_MINT_LIMIT.toLocaleString()}${suffix}`;
        return;
    }

    const minted = cachedUserStats ? Math.floor(parseInt(cachedUserStats.totalBlueMinted) / 1e18) : 0;
    mintLimitDisplay.textContent = `${minted.toLocaleString()} / ${MAX_MINT_LIMIT.toLocaleString()}${suffix}`;
}

// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Grid properties
let cols, rows, cellSize;
let gridWidth, gridHeight;
let offsetX, offsetY;

// Blue shades array
let blueShades = [];

// Global stats cache
let globalStats = null;
let previousGlobalStats = null; // Track previous values for incremental updates
let recentTransactions = [];

// Animation state
let currentIndex = 0;
let animationId = null;
let isInitialLoad = true; // Track if this is the first load

// Highlight mode state
let isHighlightMode = false;
let userMintIds = []; // Array of mintIds that belong to connected user

// Polling state
let pollingIntervalId = null;

/**
 * Get safe area inset value for a specific side (for mobile browser UI)
 * Returns the value in pixels
 */
function getSafeAreaInset(side) {
    // Create a temporary element to read CSS env() values
    const testDiv = document.createElement('div');
    testDiv.style.position = 'fixed';
    testDiv.style[side] = `env(safe-area-inset-${side}, 0px)`;
    document.body.appendChild(testDiv);

    // Get computed style
    const computedValue = getComputedStyle(testDiv)[side];
    document.body.removeChild(testDiv);

    // Parse the pixel value
    return parseFloat(computedValue) || 0;
}

/**
 * Calculate grid dimensions based on viewport
 */
function calculateGrid() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // Get safe area insets (for mobile browser UI)
    const safeAreaTop = getSafeAreaInset('top');
    const safeAreaBottom = getSafeAreaInset('bottom');

    // Margins: UI height (30px) + safe area insets
    const topMargin = MARGIN_HEIGHT + safeAreaTop;
    const bottomMargin = MARGIN_HEIGHT + safeAreaBottom;

    // Available space: full width, height minus top and bottom margins
    const availableWidth = viewportWidth;
    const availableHeight = viewportHeight - topMargin - bottomMargin;

    // Calculate aspect ratio of available space
    const aspectRatio = availableWidth / availableHeight;

    // Calculate columns and rows to fit ~10,001 squares
    // cols/rows should approximate the aspect ratio
    cols = Math.ceil(Math.sqrt(TOTAL_SQUARES * aspectRatio));
    rows = Math.ceil(TOTAL_SQUARES / cols);

    // Cell size as floating point to fill entire width exactly
    cellSize = availableWidth / cols;

    // Check if grid height fits in available space
    let gridHeightEstimate = rows * cellSize;

    // If too tall, increase columns (smaller cells)
    while (gridHeightEstimate > availableHeight) {
        cols++;
        rows = Math.ceil(TOTAL_SQUARES / cols);
        cellSize = availableWidth / cols;
        gridHeightEstimate = rows * cellSize;
    }

    // Grid dimensions (fills entire available space)
    gridWidth = availableWidth;  // Exactly full width
    gridHeight = rows * cellSize;

    // Center grid vertically if there's extra space
    const extraVerticalSpace = availableHeight - gridHeight;
    offsetX = 0;
    offsetY = topMargin + (extraVerticalSpace / 2);

    // Set canvas size with high DPI support
    canvas.width = viewportWidth * dpr;
    canvas.height = viewportHeight * dpr;

    // Scale context for high DPI
    ctx.scale(dpr, dpr);

    // Disable image smoothing for pixel-perfect rendering
    ctx.imageSmoothingEnabled = false;
}

/**
 * Simple hash function to simulate keccak256 for pseudo-random seed generation
 * This mimics on-chain: keccak256(abi.encodePacked(msg.sender, block.timestamp, tokenId))
 */
function hash(input) {
    let h = input + 0x9e3779b9;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Load minted colors from subgraph
 * Fetches all ColorMinted events and builds the color array
 */
async function loadColorsFromSubgraph() {
    const colors = await getAllColors();

    if (!colors || colors.length === 0) {
        blueShades = [];
        return;
    }

    // Initialize array with empty values
    blueShades = new Array(TOTAL_SQUARES).fill(null);

    // Fill in the minted colors at their correct positions
    colors.forEach(colorData => {
        const mintId = parseInt(colorData.mintId);
        if (mintId >= 0 && mintId < TOTAL_SQUARES) {
            blueShades[mintId] = colorData.color;
        }
    });
}

/**
 * Load global statistics from subgraph
 */
async function loadGlobalStats() {
    const stats = await getGlobalStats();

    if (!stats) {
        globalStats = {
            totalTokensMinted: '0',
            remainingTokens: '88888888',
            totalUSDCCollected: '0',
            uniqueMinters: '0',
            totalMintTransactions: '0',
            totalColorsMinted: '0'
        };
        return;
    }

    globalStats = stats;

    // TOTAL_SQUARES is now read directly from contract on page load
    // No need to update from subgraph
}

/**
 * Load recent transactions for activity feed
 */
async function loadRecentTransactions() {
    const transactions = await getRecentTransactions();

    if (!transactions || transactions.length === 0) {
        recentTransactions = [];
        return;
    }

    recentTransactions = transactions;
}

/**
 * Shuffle array in place
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * Draw the initial grid
 */
function drawGrid() {
    // Fill background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid lines
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = GRID_LINE_WIDTH;

    // Vertical lines
    for (let i = 0; i <= cols; i++) {
        const x = offsetX + i * cellSize;
        ctx.beginPath();
        ctx.moveTo(x, offsetY);
        ctx.lineTo(x, offsetY + gridHeight);
        ctx.stroke();
    }

    // Horizontal lines
    for (let i = 0; i <= rows; i++) {
        const y = offsetY + i * cellSize;
        ctx.beginPath();
        ctx.moveTo(offsetX, y);
        ctx.lineTo(offsetX + gridWidth, y);
        ctx.stroke();
    }
}

/**
 * Fill a single square
 */
function fillSquare(index) {
    if (index >= blueShades.length) return;

    // Skip if no color at this index (not minted yet)
    if (!blueShades[index]) return;

    // Reverse the visual position: start from bottom-right, move left and up
    const visualIndex = TOTAL_SQUARES - 1 - index;
    const col = visualIndex % cols;
    const row = Math.floor(visualIndex / cols);

    const x = offsetX + col * cellSize;
    const y = offsetY + row * cellSize;

    // Fill with blue shade, slightly larger to completely cover grid lines
    ctx.fillStyle = blueShades[index];
    ctx.fillRect(x - 0.5, y - 0.5, cellSize + 1, cellSize + 1);
}

/**
 * Fill unused grid cells with white to hide them
 */
function hideUnusedCells() {
    const totalCells = cols * rows;

    // Fill all cells beyond 10,001 with white, completely covering grid lines
    for (let index = TOTAL_SQUARES; index < totalCells; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);

        const x = offsetX + col * cellSize;
        const y = offsetY + row * cellSize;

        // Fill with white using oversized rectangle to completely cover grid lines
        ctx.fillStyle = 'white';
        ctx.fillRect(x - 0.5, y - 0.5, cellSize + 1, cellSize + 1);
    }
}

/**
 * Redraw the entire canvas with optional filtering
 * @param {Array|null} mintIdsToShow - If provided, only show squares at these mintIds. If null, show all.
 */
function redrawCanvas(mintIdsToShow = null) {
    // Clear canvas
    calculateGrid();
    drawGrid();
    hideUnusedCells();

    // Determine which squares to show
    if (mintIdsToShow === null) {
        // Show all minted colors
        for (let i = 0; i < blueShades.length; i++) {
            if (blueShades[i]) {
                fillSquare(i);
            }
        }
    } else {
        // Show only specified mintIds
        mintIdsToShow.forEach(mintId => {
            if (mintId >= 0 && mintId < blueShades.length && blueShades[mintId]) {
                fillSquare(mintId);
            }
        });
    }
}

/**
 * Animation loop for grid squares (time-based for smooth 2-second duration)
 * @param {number} startIndex - Index to start animating from
 * @param {number} endIndex - Index to animate to
 */
let animationStartTime = null;
const ANIMATION_DURATION = 2000; // 2 seconds to match counter animation

function animate(startIndex = 0, endIndex = null) {
    const totalMintedColors = blueShades.filter(c => c !== null).length;
    const targetEndIndex = endIndex !== null ? endIndex : totalMintedColors;

    // Set current index if this is a new animation
    if (animationStartTime === null) {
        currentIndex = startIndex;
        animationStartTime = Date.now();
    }

    const elapsed = Date.now() - animationStartTime;
    const progress = Math.min(elapsed / ANIMATION_DURATION, 1);

    // Calculate how many squares should be filled at this point
    const totalSquaresToAnimate = targetEndIndex - startIndex;
    const targetIndex = startIndex + Math.floor(totalSquaresToAnimate * progress);

    // Fill squares up to target
    while (currentIndex < targetIndex && currentIndex < targetEndIndex) {
        fillSquare(currentIndex);
        currentIndex++;
    }

    // Continue animation if not complete
    if (progress < 1) {
        animationId = requestAnimationFrame(() => animate(startIndex, endIndex));
    } else {
        if (animationId) {
            cancelAnimationFrame(animationId);
        }
        animationId = null; // Critical: reset so refreshData can run
        animationStartTime = null; // Reset for next time
    }
}

/**
 * Initialize the artwork
 */
async function init() {
    // First, initialize contract values (USDC address, mint price, etc.)
    await initializeContractValues();

    // Initialize all blockchain explorer links
    initializeExplorerLinks();

    // Load global stats FIRST to get maxMints (determines grid size)
    await loadGlobalStats();

    // Now calculate and draw grid with correct TOTAL_SQUARES
    calculateGrid();
    drawGrid();
    hideUnusedCells();  // Hide unused cells immediately

    // Load remaining data from subgraph
    await Promise.all([
        loadColorsFromSubgraph(),
        loadRecentTransactions()
    ]);

    // Update address feed
    updateAddressFeed();

    // Start animations simultaneously after a brief delay
    setTimeout(() => {
        // Animate counters from 0 to target values (initial load)
        animateCounters(true);

        // Animate grid squares loading from 0
        const totalMintedColors = blueShades.filter(c => c !== null).length;
        animate(0, totalMintedColors);
    }, 500);

    // Mark initial load complete
    isInitialLoad = false;
}

/**
 * Handle window resize
 */
function handleResize() {
    // Cancel ongoing animation
    if (animationId) {
        cancelAnimationFrame(animationId);
    }

    // Update wallet address and minted text format if connected (mobile vs desktop)
    if (isWalletConnected && userAddress) {
        const isMobile = window.innerWidth <= 768;
        const mintedSuffix = isMobile ? '' : ' minted';
        walletAddress.textContent = formatAddress(userAddress);

        // Update wallet minted text format
        const currentText = walletMinted.textContent;
        const match = currentText.match(/^([\d,]+)\s+\$(\w+)(\s+minted)?$/);
        if (match) {
            const amount = match[1];
            const symbol = match[2];
            walletMinted.textContent = `${amount} $${symbol}${mintedSuffix}`;
        }
    }

    // Reset and reinitialize
    currentIndex = 0;
    init();
}

// Debounce resize events
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(handleResize, 250);
});

// ============================================
// UI FUNCTIONALITY
// ============================================

const TOKENS_PER_CELL = 4444;
const DOLLARS_PER_8888_TOKENS = 0.88;

// UI Elements
const progressCounter = document.getElementById('progress-counter');
const colorsCounter = document.getElementById('colors-counter');
const valueCounter = document.getElementById('value-counter');
const mintersCounter = document.getElementById('minters-counter');
const addressFeed = document.getElementById('address-feed');
const addressLink = document.querySelector('.address-link');
const aboutBtn = document.getElementById('about-btn');
const aboutModal = document.getElementById('about-modal');
const closeAbout = document.getElementById('close-about');
const canvas_element = document.getElementById('canvas');
const connectBtn = document.getElementById('connect-btn');
const walletInfo = document.getElementById('wallet-info');
const walletMinted = document.getElementById('wallet-minted');
const walletUsdc = document.getElementById('wallet-usdc');
const walletAddress = document.getElementById('wallet-address');
const highlightBtn = document.getElementById('highlight-btn');
const mintBtn = document.getElementById('mint-btn');
const mintModal = document.getElementById('mint-modal');
const closeMint = document.getElementById('close-mint');
const mint1Btn = document.getElementById('mint-1-btn');
const mint8Btn = document.getElementById('mint-8-btn');
const mintLimitDisplay = document.getElementById('mint-limit-display');
const mintStatus = document.getElementById('mint-status');
const contractERC20Link = document.getElementById('contract-erc20-link');
const contractERC721Link = document.getElementById('contract-erc721-link');
const usdcContractLink = document.getElementById('usdc-contract-link');
const bmoonERC20Link = document.getElementById('bmoon-erc20-link');
const bmoonERC721Link = document.getElementById('bmoon-erc721-link');
const claimArtworkBtn = document.getElementById('claim-artwork-btn');
const artworkModal = document.getElementById('artwork-modal');
const closeArtwork = document.getElementById('close-artwork');
const artworkGrid = document.getElementById('artwork-grid');

/**
 * Initialize all blockchain explorer links based on network configuration
 */
function initializeExplorerLinks() {
    // Set ERC20 contract link
    contractERC20Link.href = `${CURRENT_NETWORK.explorer}/address/${BLUEMOON_CONTRACT}#code`;

    // Set ERC721 NFT contract link
    contractERC721Link.href = `${CURRENT_NETWORK.explorer}/address/${BLUEMOON_NFT_CONTRACT}#code`;

    // Set about page contract links
    if (bmoonERC20Link) {
        bmoonERC20Link.href = `${CURRENT_NETWORK.explorer}/address/${BLUEMOON_CONTRACT}#code`;
    }
    if (bmoonERC721Link) {
        bmoonERC721Link.href = `${CURRENT_NETWORK.explorer}/address/${BLUEMOON_NFT_CONTRACT}#code`;
    }
    // USDC link will be set after contract data loads
}

/**
 * Update USDC contract link after contract data is loaded
 */
function updateUSDCLink() {
    if (usdcContractLink && USDC_CONTRACT) {
        usdcContractLink.href = `${CURRENT_NETWORK.explorer}/address/${USDC_CONTRACT}#code`;
    }
}

/**
 * Check if mint is sold out and update mint button visibility
 */
function updateMintButtonVisibility() {
    if (!globalStats) return;

    const colorsMinted = parseInt(globalStats.totalColorsMinted) || 0;
    const isSoldOut = colorsMinted >= TOTAL_SQUARES;

    if (isSoldOut) {
        mintBtn.style.display = 'none';
    } else {
        mintBtn.style.display = 'inline-block';
    }
}

/**
 * Update progress counter and $ value from global stats (instant update, no animation)
 */
function updateCounters() {
    if (!globalStats) {
        // Default values if no stats available
        progressCounter.textContent = `0/${TOTAL_SUPPLY.toLocaleString()}`;
        colorsCounter.textContent = `0/${TOTAL_SQUARES.toLocaleString()}`;
        valueCounter.textContent = '$0';
        mintersCounter.textContent = '0';
        return;
    }

    // Parse BigInt values from subgraph (they come as strings in wei - 18 decimals)
    // Convert from wei to tokens by dividing by 10^18
    const totalMinted = Math.floor(parseInt(globalStats.totalTokensMinted) / 1e18) || 0;
    const colorsMinted = parseInt(globalStats.totalColorsMinted) || 0;
    const usdcCollected = parseFloat(globalStats.totalUSDCCollected) || 0;
    const uniqueMinters = parseInt(globalStats.uniqueMinters) || 0;

    // Update UI
    progressCounter.textContent = `${totalMinted.toLocaleString()}/${TOTAL_SUPPLY.toLocaleString()}`;
    colorsCounter.textContent = `${colorsMinted.toLocaleString()}/${TOTAL_SQUARES.toLocaleString()}`;
    valueCounter.textContent = `$${usdcCollected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    mintersCounter.textContent = `${uniqueMinters}`;

    // Check if sold out and update mint button visibility
    updateMintButtonVisibility();
}

/**
 * Animate counters from previous values to new values
 * @param {boolean} fromZero - If true, animate from 0 (initial load), otherwise from current values
 */
function animateCounters(fromZero = false) {
    if (!globalStats) {
        updateCounters();
        return;
    }

    // Parse target values
    const targetTokens = Math.floor(parseInt(globalStats.totalTokensMinted) / 1e18) || 0;
    const targetColors = parseInt(globalStats.totalColorsMinted) || 0;
    const targetUSDC = parseFloat(globalStats.totalUSDCCollected) || 0;
    const targetMinters = parseInt(globalStats.uniqueMinters) || 0;

    // Determine starting values
    let startTokens, startColors, startUSDC, startMinters;

    if (fromZero || !previousGlobalStats) {
        // Initial load: start from 0
        startTokens = 0;
        startColors = 0;
        startUSDC = 0;
        startMinters = 0;
    } else {
        // Incremental update: start from previous values
        startTokens = Math.floor(parseInt(previousGlobalStats.totalTokensMinted) / 1e18) || 0;
        startColors = parseInt(previousGlobalStats.totalColorsMinted) || 0;
        startUSDC = parseFloat(previousGlobalStats.totalUSDCCollected) || 0;
        startMinters = parseInt(previousGlobalStats.uniqueMinters) || 0;
    }

    // Set initial display values
    progressCounter.textContent = `${startTokens.toLocaleString()}/${TOTAL_SUPPLY.toLocaleString()}`;
    colorsCounter.textContent = `${startColors.toLocaleString()}/${TOTAL_SQUARES.toLocaleString()}`;
    valueCounter.textContent = `$${startUSDC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    mintersCounter.textContent = `${startMinters}`;

    // Animation parameters
    const duration = 2000; // 2 seconds
    const startTime = Date.now();

    // Easing function (ease out)
    const easeOutQuad = (t) => t * (2 - t);

    function animate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutQuad(progress);

        // Interpolate from start to target
        const currentTokens = Math.floor(startTokens + (targetTokens - startTokens) * easedProgress);
        const currentColors = Math.floor(startColors + (targetColors - startColors) * easedProgress);
        const currentUSDC = startUSDC + (targetUSDC - startUSDC) * easedProgress;
        const currentMinters = Math.floor(startMinters + (targetMinters - startMinters) * easedProgress);

        // Update UI
        progressCounter.textContent = `${currentTokens.toLocaleString()}/${TOTAL_SUPPLY.toLocaleString()}`;
        colorsCounter.textContent = `${currentColors.toLocaleString()}/${TOTAL_SQUARES.toLocaleString()}`;
        valueCounter.textContent = `$${currentUSDC.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        mintersCounter.textContent = `${currentMinters}`;

        // Continue animation if not complete
        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            // Animation complete - check if sold out
            updateMintButtonVisibility();
        }
    }

    animate();
}

/**
 * Format address for display (0x1234...5678)
 * Shorter format on mobile (0x12...78)
 */
function formatAddress(address) {
    if (!address || address.length < 10) return '0x0000...0000';

    // Use shorter format on mobile
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        return `${address.slice(0, 4)}...${address.slice(-2)}`;
    }

    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Update address feed with real transaction data
 */
let currentTxIndex = 0;

function updateAddressFeed() {
    if (!recentTransactions || recentTransactions.length === 0) {
        // No transactions yet, show default
        addressLink.href = '#';
        addressLink.textContent = '0x0000...0000';
        addressFeed.innerHTML = `0 minted by <a href="#" class="address-link" target="_blank">0x0000...0000</a>`;
        return;
    }

    // Cycle through recent transactions
    const tx = recentTransactions[currentTxIndex % recentTransactions.length];

    // Calculate actual token amount (1 mint = 4444 tokens, 8 mints = 35552 tokens)
    const mintCount = parseInt(tx.amount) || 0;
    const tokenAmount = TOKENS_PER_MINT ? (mintCount * TOKENS_PER_MINT).toLocaleString() : mintCount;

    // Update the address link
    const explorerUrl = `${CURRENT_NETWORK.explorer}/address/${tx.minter}`;
    addressLink.href = explorerUrl;
    addressLink.textContent = formatAddress(tx.minter);

    // Update the feed text (need to rebuild to preserve link)
    addressFeed.innerHTML = `${tokenAmount} minted by <a href="${explorerUrl}" class="address-link" target="_blank">${formatAddress(tx.minter)}</a>`;

    currentTxIndex++;
}

// Update address feed every 3 seconds
let addressFeedInterval;
function startAddressFeed() {
    updateAddressFeed();
    addressFeedInterval = setInterval(() => {
        updateAddressFeed();
    }, 3000);
}

/**
 * Close all modals and show canvas
 */
function closeAllModals() {
    aboutModal.classList.remove('active');
    mintModal.classList.remove('active');
    artworkModal.classList.remove('active');
    canvas_element.style.display = 'block';
}

/**
 * About modal handlers
 */
aboutBtn.addEventListener('click', () => {
    closeAllModals();
    aboutModal.classList.add('active');
    canvas_element.style.display = 'none';
});

closeAbout.addEventListener('click', () => {
    closeAllModals();
});

/**
 * Artwork gallery modal handlers
 */
claimArtworkBtn.addEventListener('click', async () => {
    closeAllModals();
    artworkModal.classList.add('active');
    canvas_element.style.display = 'none';
    await loadArtworkGallery();
});

closeArtwork.addEventListener('click', () => {
    closeAllModals();
});

/**
 * Wallet connection handler
 */
connectBtn.addEventListener('click', async () => {
    await connectWallet();
});

/**
 * Highlight button handler
 */
highlightBtn.addEventListener('click', () => {
    if (!userMintIds || userMintIds.length === 0) {
        return;
    }

    // Toggle highlight mode
    isHighlightMode = !isHighlightMode;

    if (isHighlightMode) {
        highlightBtn.textContent = 'show all';
        // Redraw canvas showing only user's colors
        redrawCanvas(userMintIds);
    } else {
        highlightBtn.textContent = 'highlight';
        // Redraw canvas showing all colors
        redrawCanvas(null);
    }
});

/**
 * Mint button handler - Opens mint modal
 */
mintBtn.addEventListener('click', () => {
    closeAllModals();
    openMintModal();
});

/**
 * Close mint modal
 */
closeMint.addEventListener('click', () => {
    closeMintModal();
});

/**
 * Mint 1 button
 */
mint1Btn.addEventListener('click', () => {
    handleMint(1); // Fire-and-forget to allow rapid clicking
});

// Clear status message when hovering over mint button
mint1Btn.addEventListener('mouseenter', () => {
    mintStatus.textContent = '';
});

/**
 * Mint 8 button
 */
mint8Btn.addEventListener('click', () => {
    handleMint(8); // Fire-and-forget to allow rapid clicking
});

// Clear status message when hovering over mint button
mint8Btn.addEventListener('mouseenter', () => {
    mintStatus.textContent = '';
});

/**
 * Music player functionality
 */
const audioPlayer = document.getElementById('audio-player');
const playPauseBtn = document.getElementById('play-pause-btn');

let isPlaying = false;

// Update button state based on audio state
function updatePlayPauseButton() {
    if (audioPlayer.paused) {
        playPauseBtn.textContent = '▶';
        isPlaying = false;
    } else {
        playPauseBtn.textContent = '◼';
        isPlaying = true;
    }
}

// Auto-play on page load
function startMusic() {
    audioPlayer.play().then(() => {
        updatePlayPauseButton();
    }).catch(error => {
        // Autoplay might be blocked by browser
        console.log('Autoplay blocked, will try on first interaction:', error);
        updatePlayPauseButton();

        // Try to play on first user interaction
        const tryPlay = () => {
            audioPlayer.play().then(() => {
                updatePlayPauseButton();
            });
            document.removeEventListener('click', tryPlay);
            document.removeEventListener('keydown', tryPlay);
        };

        document.addEventListener('click', tryPlay, { once: true });
        document.addEventListener('keydown', tryPlay, { once: true });
    });
}

// Play/pause toggle
playPauseBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering the tryPlay listener
    if (isPlaying) {
        audioPlayer.pause();
    } else {
        audioPlayer.play();
    }
    updatePlayPauseButton();
});

// Listen to audio events
audioPlayer.addEventListener('play', updatePlayPauseButton);
audioPlayer.addEventListener('pause', updatePlayPauseButton);

// ============================================
// POLLING & DATA REFRESH
// ============================================

/**
 * Refresh data from subgraph (stats and recent transactions)
 * Called every 15 seconds to keep UI up to date
 */
async function refreshData() {
    const timestamp = new Date().toLocaleTimeString();
    // Don't refresh if animation is still running
    if (animationId !== null) {
        return;
    }

    // Store previous state
    const previousColorCount = blueShades.filter(c => c !== null).length;
    const previousTokens = globalStats ? Math.floor(parseInt(globalStats.totalTokensMinted) / 1e18) : 0;
    previousGlobalStats = globalStats ? { ...globalStats } : null;

    // Refresh all data
    await Promise.all([
        loadColorsFromSubgraph(),
        loadGlobalStats(),
        loadRecentTransactions()
    ]);

    // Check if there are new colors
    const newColorCount = blueShades.filter(c => c !== null).length;
    const newTokens = globalStats ? Math.floor(parseInt(globalStats.totalTokensMinted) / 1e18) : 0;

    if (newColorCount > previousColorCount) {
        // Update address feed with new transactions
        updateAddressFeed();

        // If in highlight mode, just update the data and redraw with filter
        if (isHighlightMode) {
            redrawCanvas(userMintIds);
            animateCounters(false);
        } else {
            // Animate counters from previous values to new values
            animateCounters(false);
            // Animate only the new squares
            animate(previousColorCount, newColorCount);
        }
    } else if (newTokens !== previousTokens) {
        // Just update counters instantly
        updateCounters();
    }

    // Update wallet UI if connected (refreshes BLUE minted and USDC balance)
    if (isWalletConnected && userAddress) {
        await updateWalletUI();

        // Also update mint limit display if modal is open
        if (mintModal.classList.contains('active')) {
            updateMintLimitDisplay();
        }
    }
}

/**
 * Start polling for updates every 15 seconds
 */
function startPolling() {
    // Clear any existing interval first
    if (pollingIntervalId !== null) {
        clearInterval(pollingIntervalId);
    }
    pollingIntervalId = setInterval(refreshData, POLL_INTERVAL);
}

/**
 * Stop polling for updates
 */
function stopPolling() {
    if (pollingIntervalId !== null) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }
}

/**
 * Handle page visibility changes to save API usage
 * Stops polling when tab is hidden, resumes when visible
 */
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Tab is now hidden - stop polling to save API calls
        stopPolling();
    } else {
        // Tab is now visible - resume polling
        startPolling();
        // Also refresh data immediately so user sees fresh data
        refreshData();
    }
});

// Initialize on load
// ============================================
// ARTWORK GALLERY FUNCTIONS
// ============================================

/**
 * Load and display the NFT artwork gallery
 */
async function loadArtworkGallery() {
    try {
        // Show loading state
        artworkGrid.innerHTML = '<div style="text-align: center; padding: 40px;">loading artworks...</div>';

        // Create a read-only provider for Base Sepolia
        const readProvider = new ethers.providers.JsonRpcProvider(BASE_RPC);

        // Connect to NFT contract
        const nftContract = new ethers.Contract(BLUEMOON_NFT_CONTRACT, BLUEMOON_NFT_ABI, readProvider);

        // Get total supply, artist proofs, and total minted
        const totalSupply = await nftContract.TOTAL_SUPPLY();
        const artistProofs = await nftContract.ARTIST_PROOFS();
        const totalMinted = await nftContract.totalMinted();

        // Update modal heading
        const modalHeading = document.querySelector('#artwork-modal h2');
        modalHeading.textContent = `${totalMinted}/${totalSupply} (${artistProofs} AP)`;

        // Clear the grid
        artworkGrid.innerHTML = '';

        // Create boxes for all NFTs (0 to totalSupply-1)
        for (let tokenId = 0; tokenId < totalSupply; tokenId++) {
            const isMinted = tokenId < totalMinted;
            const nftBox = await createNFTBox(tokenId, isMinted, nftContract);
            artworkGrid.appendChild(nftBox);
        }

    } catch (error) {
        console.error('Error loading artwork gallery:', error);
        artworkGrid.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--blue);">error loading artworks. please try again.</div>';
    }
}

/**
 * Create an NFT box element
 */
async function createNFTBox(tokenId, isMinted, nftContract) {
    const box = document.createElement('div');
    box.className = 'nft-box';

    if (isMinted) {
        // NFT is minted - fetch metadata
        try {
            const tokenURIData = await nftContract.tokenURI(tokenId);
            const metadata = parseTokenURI(tokenURIData);

            // Create artwork container
            const artworkDiv = document.createElement('div');
            artworkDiv.className = 'nft-artwork';
            artworkDiv.innerHTML = metadata.svg;

            // Create traits
            const traitsDiv = document.createElement('div');
            traitsDiv.className = 'nft-traits';

            const addressTrait = document.createElement('div');
            addressTrait.className = 'nft-trait';
            addressTrait.innerHTML = `
                <span class="trait-label">minter:</span>
                <span class="trait-value">${shortenAddress(metadata.minter)}</span>
            `;

            const blockTrait = document.createElement('div');
            blockTrait.className = 'nft-trait';
            blockTrait.innerHTML = `
                <span class="trait-label">block:</span>
                <span class="trait-value">${metadata.blockNumber}</span>
            `;

            const tokenIdTrait = document.createElement('div');
            tokenIdTrait.className = 'nft-trait';
            tokenIdTrait.innerHTML = `
                <span class="trait-label">token id:</span>
                <span class="trait-value">${tokenId}</span>
            `;

            traitsDiv.appendChild(addressTrait);
            traitsDiv.appendChild(blockTrait);
            traitsDiv.appendChild(tokenIdTrait);

            // Create view button
            const viewBtn = document.createElement('button');
            viewBtn.className = 'nft-view-btn';
            viewBtn.textContent = 'view';
            viewBtn.addEventListener('click', () => {
                openNFTInNewTab(metadata.svg, tokenId);
            });

            box.appendChild(artworkDiv);
            box.appendChild(traitsDiv);
            box.appendChild(viewBtn);

        } catch (error) {
            console.error(`Error loading NFT #${tokenId}:`, error);
            box.innerHTML = `<div class="nft-artwork unminted">error loading #${tokenId}</div>`;
        }

    } else {
        // NFT not minted yet
        const artworkDiv = document.createElement('div');
        artworkDiv.className = 'nft-artwork unminted';
        artworkDiv.textContent = 'not minted yet';

        const traitsDiv = document.createElement('div');
        traitsDiv.className = 'nft-traits';
        traitsDiv.innerHTML = `
            <div class="nft-trait">
                <span class="trait-label">minter:</span>
                <span class="trait-value">-</span>
            </div>
            <div class="nft-trait">
                <span class="trait-label">block:</span>
                <span class="trait-value">-</span>
            </div>
            <div class="nft-trait">
                <span class="trait-label">token id:</span>
                <span class="trait-value">${tokenId}</span>
            </div>
        `;

        const mintBtn = document.createElement('button');
        mintBtn.className = 'nft-view-btn mint-style';
        mintBtn.textContent = 'claim/mint';
        mintBtn.addEventListener('click', async () => {
            await mintNFT(tokenId, mintBtn);
        });

        box.appendChild(artworkDiv);
        box.appendChild(traitsDiv);
        box.appendChild(mintBtn);
    }

    return box;
}

/**
 * Shorten an Ethereum address to format: 0x1234...5678
 */
function shortenAddress(address) {
    if (!address || address === '-') return '-';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

/**
 * Parse base64-encoded tokenURI data
 */
function parseTokenURI(tokenURIData) {
    // Remove "data:application/json;base64," prefix
    const base64Data = tokenURIData.replace('data:application/json;base64,', '');

    // Decode base64
    const jsonString = atob(base64Data);
    const metadata = JSON.parse(jsonString);

    // Extract SVG from image data URI
    const svgBase64 = metadata.image.replace('data:image/svg+xml;base64,', '');
    const svg = atob(svgBase64);

    // Extract traits
    const minterTrait = metadata.attributes.find(attr => attr.trait_type === 'Minter');
    const blockTrait = metadata.attributes.find(attr => attr.trait_type === 'Block Number');

    return {
        svg: svg,
        minter: minterTrait ? minterTrait.value : '-',
        blockNumber: blockTrait ? blockTrait.value : '-'
    };
}

/**
 * Mint an NFT (requires wallet connection and BLUE token approval)
 */
async function mintNFT(tokenId, buttonElement) {
    try {
        // Check if wallet is connected
        if (!isWalletConnected || !signer) {
            buttonElement.textContent = 'connect wallet first';
            setTimeout(() => {
                buttonElement.textContent = 'claim/mint';
            }, 2000);
            return;
        }

        // Get user address
        const address = await signer.getAddress();

        // Connect to contracts
        const nftContract = new ethers.Contract(BLUEMOON_NFT_CONTRACT, BLUEMOON_NFT_ABI, signer);
        const blueTokenAddress = await nftContract.blueToken();
        const blueContract = new ethers.Contract(blueTokenAddress, ERC20_ABI, signer);

        // Get mint price (1,777,778 BLUE tokens per NFT)
        const mintPrice = ethers.utils.parseEther('1777778');

        // Check BLUE balance
        buttonElement.textContent = 'checking balance...';
        const balance = await blueContract.balanceOf(address);

        if (balance.lt(mintPrice)) {
            buttonElement.textContent = `insufficient $${TOKEN_SYMBOL || 'BLUE'}`;
            setTimeout(() => {
                buttonElement.textContent = 'claim/mint';
            }, 2000);
            return;
        }

        // Check approval
        buttonElement.textContent = 'checking approval...';
        const allowance = await blueContract.allowance(address, BLUEMOON_NFT_CONTRACT);

        if (allowance.lt(mintPrice)) {
            // Need approval first - approve exactly the mint price for this NFT
            // User will need to approve again for each subsequent NFT mint
            buttonElement.textContent = `approve $${TOKEN_SYMBOL || 'BLUE'}...`;
            const approveTx = await blueContract.approve(BLUEMOON_NFT_CONTRACT, mintPrice);
            buttonElement.textContent = 'approving...';
            await approveTx.wait();

            // Verify approval was successful
            buttonElement.textContent = 'verifying approval...';
            const newAllowance = await blueContract.allowance(address, BLUEMOON_NFT_CONTRACT);

            if (newAllowance.lt(mintPrice)) {
                // Approval didn't work for some reason
                buttonElement.textContent = 'approval failed - try again';
                setTimeout(() => {
                    buttonElement.textContent = 'claim/mint';
                }, 3000);
                return;
            }

            // Approval successful - continue to minting automatically
        }

        // Allowance is sufficient (or just approved), proceed with minting
        buttonElement.textContent = 'minting...';
        const mintTx = await nftContract.mint();
        buttonElement.textContent = 'confirming...';
        await mintTx.wait();

        buttonElement.textContent = 'minted!';

        // Reload the gallery after a short delay
        setTimeout(async () => {
            await loadArtworkGallery();
        }, 1500);

    } catch (error) {
        console.error('Error minting NFT:', error);

        // Better error handling
        let errorMessage = 'error - try again';

        if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
            errorMessage = 'user rejected transaction';
        }
        else if (error.code === 'INSUFFICIENT_FUNDS' || error.code === -32000) {
            errorMessage = 'insufficient ETH for gas';
        }
        else if (error.code === 'NETWORK_ERROR' || error.code === 'CALL_EXCEPTION') {
            errorMessage = 'wrong network or contract error';
        }
        else if (error.message) {
            if (error.message.includes('insufficient')) {
                errorMessage = `insufficient $${TOKEN_SYMBOL || 'BLUE'}`;
            }
            else if (error.message.includes('Already minted') || error.message.includes('already minted')) {
                errorMessage = 'already minted';
            }
            else if (error.message.includes('Max supply reached')) {
                errorMessage = 'max supply reached';
            }
            else if (error.message.includes('wrong network') || error.message.includes('unsupported network')) {
                errorMessage = 'wrong network';
            }
        }

        buttonElement.textContent = errorMessage;
        setTimeout(() => {
            buttonElement.textContent = 'claim/mint';
        }, 2000);
    }
}

/**
 * Open NFT artwork in new tab as PNG image (2200x2200px, Display P3 color space)
 */
function openNFTInNewTab(svg, tokenId) {
    // Generate timestamp for snapshot (YYYY-MM-DD_HH-MM-SS format)
    const now = new Date();
    const timestamp = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + '_' +
        String(now.getHours()).padStart(2, '0') + '-' +
        String(now.getMinutes()).padStart(2, '0') + '-' +
        String(now.getSeconds()).padStart(2, '0');

    const filename = `bluemoon_nft_token_${tokenId}_${timestamp}.png`;

    // Open window immediately (synchronously with user click) to avoid popup blockers
    const newWindow = window.open('', `_blank_nft_${tokenId}`);

    if (!newWindow) {
        alert('Please allow popups for this site to view NFT artwork.');
        return;
    }

    // Write loading state to the window
    newWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${filename}</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    background: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    font-family: monospace;
                    color: #234fde;
                }
            </style>
        </head>
        <body>
            <div>Loading artwork...</div>
        </body>
        </html>
    `);

    // Create a canvas with Display P3 color space for wider color gamut
    const canvas = document.createElement('canvas');
    const size = 4400; // 4400x4400px (200px per grid cell for 22x22 grid)
    canvas.width = size;
    canvas.height = size;

    // Get context with Display P3 color space (important for accurate blue hues)
    // Fallback to regular 2d context if Display P3 not supported
    let ctx;
    try {
        ctx = canvas.getContext('2d', {
            colorSpace: 'display-p3',
            willReadFrequently: false
        });
    } catch (e) {
        ctx = canvas.getContext('2d');
    }

    // Disable all image smoothing for pixel-perfect rendering
    ctx.imageSmoothingEnabled = false;
    if (ctx.imageSmoothingQuality) {
        ctx.imageSmoothingQuality = 'high';
    }

    // Create an image from the SVG
    const img = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);

    // Timeout fallback if image doesn't load within 10 seconds
    const loadTimeout = setTimeout(() => {
        newWindow.document.open();
        newWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Error</title>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        background: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        font-family: monospace;
                        color: #234fde;
                    }
                </style>
            </head>
            <body>
                <div>Error rendering NFT artwork. Please try again.</div>
            </body>
            </html>
        `);
        newWindow.document.close();
        URL.revokeObjectURL(svgUrl);
    }, 10000);

    img.onload = function() {
        clearTimeout(loadTimeout);
        // Draw SVG to canvas at 2200x2200
        ctx.drawImage(img, 0, 0, size, size);

        // Clean up SVG blob URL
        URL.revokeObjectURL(svgUrl);

        // Convert canvas to data URL (base64 PNG)
        const dataUrl = canvas.toDataURL('image/png', 1.0);

        // Write the complete HTML with the image to the window
        newWindow.document.open();
        newWindow.document.write(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${filename}</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: white;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: monospace;
        }
        img {
            max-width: 90%;
            max-height: 80vh;
            display: block;
            cursor: pointer;
            image-rendering: -moz-crisp-edges;
            image-rendering: -webkit-crisp-edges;
            image-rendering: pixelated;
            image-rendering: crisp-edges;
        }
        .download-btn {
            margin-top: 20px;
            padding: 10px 20px;
            background: white;
            color: #234fde;
            border: 1px solid #234fde;
            font-family: monospace;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
        }
        .download-btn:hover {
            background: #234fde;
            color: white;
        }
    </style>
</head>
<body>
    <img src="${dataUrl}" alt="${filename}" id="nftImage">
    <a href="${dataUrl}" download="${filename}" class="download-btn" id="downloadLink">DOWNLOAD</a>
    <script>
        // Allow clicking the image to download as well
        document.getElementById('nftImage').addEventListener('click', function() {
            document.getElementById('downloadLink').click();
        });

        // Also enable right-click context menu to work on the image
        document.getElementById('nftImage').addEventListener('contextmenu', function(e) {
            e.stopPropagation();
        });
    </script>
</body>
</html>`);
        newWindow.document.close();
    };

    img.onerror = function(error) {
        clearTimeout(loadTimeout);
        newWindow.document.open();
        newWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Error</title>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        background: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        font-family: monospace;
                        color: #234fde;
                    }
                </style>
            </head>
            <body>
                <div>Error rendering NFT artwork. Please try again.</div>
            </body>
            </html>
        `);
        newWindow.document.close();
    };

    img.src = svgUrl;
}

async function startup() {
    await init();
    // Update mint button prices after DOM is ready
    updateMintButtonPrices();
    // Update max USDC approval amount
    updateMaxUSDCApproval();
    startAddressFeed();
    startMusic();
    startPolling();
}

startup();
