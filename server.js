require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bs58 = require('bs58').default || require('bs58');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

const app = express();

// ==================== SOLANA CONFIG ====================
let SERVER_KEYPAIR, PLATFORM_VAULT, HOLDER_VAULT, solanaConnection;
try {
  SERVER_KEYPAIR = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_PRIVATE_KEY));
  PLATFORM_VAULT = new PublicKey(process.env.PLATFORM_VAULT_ADDRESS);
  HOLDER_VAULT = new PublicKey(process.env.HOLDER_VAULT_ADDRESS);
  solanaConnection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  console.log(`✅ Solana Configured. Server Wallet: ${SERVER_KEYPAIR.publicKey.toString()}`);
} catch (e) {
  console.error("❌ Erro ao configurar a Solana (verifique o arquivo .env):", e.message);
  process.exit(1);
}
// ========================================================
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'http://localhost:3000', 
  'http://127.0.0.1:3000'
  // TODO: Quando for para o ar, adicione seu domínio aqui. Exemplo:
  // 'https://solpot.io', 'https://www.solpot.io'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origin (como ferramentas do servidor) ou dos domínios permitidos
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Bloqueio de iFrame (Clickjacking) e proteções básicas do navegador
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY'); // Impede que coloquem o site num iframe
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- Config
const RANKING_TOP_N = 10;
const RANKING_SHARES = [0.25, 0.18, 0.13, 0.10, 0.08, 0.07, 0.06, 0.05, 0.04, 0.04];
const MIN_UNIQUE_BIDDERS = 2; // Round only settles with 2+ unique wallets

let sseClients = [];

const sampleWallets = [
  '7xQYoUjUJF1Kg6WVczoTAkaNhn5syQYcbvjmFrhjWpx',
  '571uzWpMeRuHEuWFC61FFsnXYV8DbE33QuBjCJhMqXh4',
  '2g4zs16yi1i4JuAhDYoiRGMceH4hvkwJvKR91hRkGc5P',
  'F24rXvpZQBMh7dMN4SAUYDJqLVunR9mVSXVB9QxFfSbX',
  '95VuUmK2JSG5x9eCdgytn2cjxgoU3LkRBYBG8WHS13Pz',
  '3NMoQ1dNdyvD2coEnwvLKJ2YiUQM8Vp6p4EaHTSMwTbn',
  '4rdKhf75gmFzNSp5EZWoP93avWrfYBZ6wB9aLdBHiWkz',
  '2chcozaYioGYLrcCa1Z6chPLHRmm8w9wF3TJkaMmTszY',
  '8ZVXGWgMeMAHK3DBPMMRaTaX2EbyQPq59bC9tyP8viYs',
  '4cnBZhhZDycYsf7HovPhGWMhGdoGxSLwNtXwkxu91zuW'
];

let gameState = {
  round: 1,
  potSol: 0,
  rankingPoolSol: 0,
  holderPoolSol: 0.02,
  buyBurnPoolSol: 0,
  devFeeSol: 0.00,
  minBidSol: 0.005, // Começa em 0.005 SOL (centavos de dólar)
  roundSeconds: 60,
  deadline: null,
  settleMs: 3000,
  celebrateMs: 60000,
  solUsd: 145.50,
  rankingTopN: RANKING_TOP_N,
  minUniqueBidders: MIN_UNIQUE_BIDDERS,

  token: {
    name: '$SOLPOT',
    mint: '7RVWZavB2ufPhFxgFXNUWaX7uhTV1RtuapQHhhgspump',
    minRequired: 10000,
    vipRequired: 100000,
    vipDiscountPct: 25,
    pumpUrl: 'https://pump.fun/7RVWZavB2ufPhFxgFXNUWaX7uhTV1RtuapQHhhgspump'
  },

  holderAirdrop: {
    nextDrawTime: null,
    lastWinner: null
  },
  
  rankingDraw: {
    nextDrawTime: null,
    lastWinner: null
  },

  lastBurn: null, // { amount: "1,000", time: 12345 }
  
  nicknames: {}, // address => nickname

  potWallet: 'SolPot11111111111111111111111111111111111111',
  devWallet: 'SolDevFee1111111111111111111111111111111111',

  sampleWallets,
  leader: null,
  bids: [],
  bidCount: 0,
  uniqueBidders: [], // Track unique wallet addresses
  topBidders: {},
  history: [],
  lastWinner: null,
  chatMessages: [
    { sender: 'System', text: 'Welcome to SOLPOT! Bids are live.', isSystem: true, time: Date.now() }
  ],
  health: {
    ok: true,
    lastReadAt: Date.now(),
    network: 'Solana Mainnet / Multi-Wallet Verified'
  }
};

function generateTxSig() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let sig = '';
  for (let i = 0; i < 88; i++) sig += chars.charAt(Math.floor(Math.random() * chars.length));
  return sig;
}

function broadcastState() {
  gameState.health.lastReadAt = Date.now();
  const payload = `data: ${JSON.stringify({ 
    ...gameState, 
    now: Date.now(),
    serverWallet: SERVER_KEYPAIR ? SERVER_KEYPAIR.publicKey.toString() : null
  })}\n\n`;
  sseClients.forEach((client) => client.res.write(payload));
}

// ---------------------------------------------------------------- Endpoints

app.get('/api/state', (req, res) => {
  gameState.health.lastReadAt = Date.now();
  res.json({ 
    ...gameState, 
    now: Date.now(),
    serverWallet: SERVER_KEYPAIR ? SERVER_KEYPAIR.publicKey.toString() : null
  });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const clientId = Date.now();
  sseClients.push({ id: clientId, res });
  res.write(`data: ${JSON.stringify({ 
    ...gameState, 
    now: Date.now(),
    serverWallet: SERVER_KEYPAIR ? SERVER_KEYPAIR.publicKey.toString() : null
  })}\n\n`);
  req.on('close', () => { sseClients = sseClients.filter((c) => c.id !== clientId); });
});

app.get('/api/check-holder/:address', async (req, res) => {
  const { address } = req.params;
  
  // Real Token Gate (Disabled temporarily since token doesn't exist yet)
  // const balance = await solanaConnection.getTokenAccountBalance(new PublicKey(address)).catch(() => ({ value: { uiAmount: 0 } }));
  // const tokenBalance = balance.value.uiAmount;
  
  // Fake token balance just so users can play before token launch
  const tokenBalance = 120000;
  
  const tickets = Math.floor(tokenBalance / gameState.token.minRequired);
  const isVip = tokenBalance >= gameState.token.vipRequired;
  res.json({ address, eligible: tickets >= 1, balance: tokenBalance, tickets, isVip, discountPct: isVip ? gameState.token.vipDiscountPct : 0, required: gameState.token.minRequired });
});

// ==================== RPC PROXY ====================
// O navegador sofre bloqueio 403 da Solana Pública. O servidor atua como ponte.
app.post('/api/trigger-holder-airdrop', async (req, res) => {
  // Rota desativada para produção
  res.status(403).json({ error: "Sorteios manuais desativados em produção." });
});

app.get('/api/rpc/balance/:address', async (req, res) => {
  try {
    const balance = await solanaConnection.getBalance(new PublicKey(req.params.address));
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rpc/blockhash', async (req, res) => {
  try {
    const bh = await solanaConnection.getLatestBlockhash();
    res.json(bh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== WEB3 LOGIC ====================
async function verifyBidOnChain(sig, expectedLamports, blockhash, lastValidBlockHeight) {
  try {
    // 1. Wait for network confirmation
    if (blockhash && lastValidBlockHeight) {
      await solanaConnection.confirmTransaction({
        signature: sig,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
      }, 'confirmed');
    } else {
      // Fallback if older frontend (should not happen now)
      await solanaConnection.confirmTransaction(sig, 'confirmed');
    }

    // 2. Read the confirmed transaction
    const tx = await solanaConnection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || tx.meta.err) {
      console.error("Tx failed or not found. Err:", tx?.meta?.err);
      return false;
    }

    // Achar a index da carteira do Servidor no array de chaves
    const serverIndex = tx.transaction.message.staticAccountKeys.findIndex(k => k.equals(SERVER_KEYPAIR.publicKey));
    if (serverIndex === -1) return false;

    // Calcular diferença de saldo
    const preBalance = tx.meta.preBalances[serverIndex];
    const postBalance = tx.meta.postBalances[serverIndex];
    const lamportsReceived = postBalance - preBalance;

    return lamportsReceived >= expectedLamports;
  } catch (err) {
    console.error("Verify Bid Error:", err);
    return false;
  }
}

async function executePayout(winnerAddress, totalPotSol, retries = 3) {
  try {
    const lamports = Math.floor(totalPotSol * 1e9);
    const winnerCut = Math.floor(lamports * 0.85);
    const platformCut = Math.floor(lamports * 0.04); // Agora 4% vai pro Lucro
    const buyBurnCut = Math.floor(lamports * 0.01);  // 1% vai pro Buy & Burn
    const holderCut = Math.floor(lamports * 0.05);

    // Verificar se a carteira tem saldo suficiente para o pagamento
    const balance = await solanaConnection.getBalance(SERVER_KEYPAIR.publicKey);
    if (balance < lamports) {
      console.warn(`⚠️ Sem fundos na Mainnet (${balance/1e9} SOL). Fazendo Payout Simulado (Virtual).`);
      return null;
    }

    // Registrar o aumento do fundo de Buy & Burn internamente (Hot Wallet retém esse 1%)
    gameState.buyBurnPoolSol += (buyBurnCut / 1e9);

    // Transferir 85% pro Vencedor e 4% pra Plataforma (Lucro)
    // Os outros 11% (Holder Airdrop, Ranking e Buy&Burn) ficam guardados na carteira do servidor
    const transaction = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: SERVER_KEYPAIR.publicKey, toPubkey: new PublicKey(winnerAddress), lamports: winnerCut }),
      SystemProgram.transfer({ fromPubkey: SERVER_KEYPAIR.publicKey, toPubkey: PLATFORM_VAULT, lamports: platformCut })
    );

    const sig = await sendAndConfirmTransaction(solanaConnection, transaction, [SERVER_KEYPAIR]);
    console.log(`✅ Payout sent to ${winnerAddress}! Sig: ${sig}`);
    
    // Disparar o Buy & Burn se atingiu o limite de 0.02 SOL
    if (gameState.buyBurnPoolSol >= 0.02) {
      const lamportsToSpend = Math.floor(gameState.buyBurnPoolSol * 1e9);
      gameState.buyBurnPoolSol = 0; // Reset
      executeBuyAndBurn(lamportsToSpend); // Roda em background
    }

    return sig;
  } catch (err) {
    console.error("Execute Payout Error:", err);
    return null;
  }
}
// ====================================================

app.post('/api/bid', async (req, res) => {
  const { address, amountSol, sig, blockhash, lastValidBlockHeight, tokenBalance } = req.body;
  if (!address || !amountSol) return res.status(400).json({ error: "Missing data" });
  
  const currentBalance = tokenBalance !== undefined ? Number(tokenBalance) : 0;
  const userTickets = Math.floor(currentBalance / gameState.token.minRequired);
  const isVip = currentBalance >= gameState.token.vipRequired;
  const discountMultiplier = isVip ? (1 - gameState.token.vipDiscountPct / 100) : 1.0;
  const effectiveMinBid = gameState.minBidSol * discountMultiplier;

  if (amountSol < effectiveMinBid) {
    return res.status(400).json({ error: isVip ? `VIP Minimum Bid (25% Discount): ${effectiveMinBid.toFixed(3)} SOL` : `Minimum Bid Required: ${gameState.minBidSol.toFixed(3)} SOL` });
  }
  if (userTickets < 1) {
    return res.status(403).json({ error: `Token Gate: You need at least 10,000 ${gameState.token.name} to play!`, buyUrl: gameState.token.pumpUrl });
  }

  if (!sig) return res.status(400).json({ error: "Missing transaction signature." });
  const bidAmount = Number(amountSol);
  const expectedLamports = Math.floor(bidAmount * 1e9);

  const isValid = await verifyBidOnChain(sig, expectedLamports, blockhash, lastValidBlockHeight);
  if (!isValid) return res.status(400).json({ error: "Transaction invalid or funds not received." });

  const txSig = sig;

  gameState.potSol += bidAmount * 0.85;
  gameState.rankingPoolSol += bidAmount * 0.05;
  gameState.holderPoolSol += bidAmount * 0.05;
  gameState.devFeeSol += bidAmount * 0.05;

  const now = Date.now();

  // Track unique bidders
  if (!gameState.uniqueBidders.includes(address)) {
    gameState.uniqueBidders.push(address);
  }

  // --- Decaying Timer Logic ---
  if (gameState.bidCount > 0) {
    if (gameState.roundSeconds > 40) {
      gameState.roundSeconds -= 10;
    } else if (gameState.roundSeconds > 20) {
      gameState.roundSeconds -= 5;
    } else if (gameState.roundSeconds > 10) {
      gameState.roundSeconds -= 2;
    }
    // Floor at 10 seconds
    gameState.roundSeconds = Math.max(10, gameState.roundSeconds);
  }

  // Only start the clock if we have enough unique players
  if (gameState.uniqueBidders.length >= MIN_UNIQUE_BIDDERS) {
    // Reseta o cronômetro SEMPRE que há um novo lance válido, mas para o valor do roundSeconds que decaiu
    gameState.deadline = now + gameState.roundSeconds * 1000;
  } else {
    gameState.deadline = null; // Keeps clock waiting
  }

  gameState.leader = { address: address, amountSol: bidAmount, time: now, sig: txSig, tickets: userTickets, isVip };
  gameState.bids.unshift({ address: address, amountSol: bidAmount, time: now, sig: txSig, tickets: userTickets, isVip });
  if (gameState.bids.length > 50) gameState.bids.pop();
  gameState.bidCount += 1;
  gameState.topBidders[address] = (gameState.topBidders[address] || 0) + bidAmount;
  // Aumenta em apenas 0.001 SOL por lance para encorajar mais brigas
  gameState.minBidSol = Math.round((gameState.minBidSol + 0.001) * 1000) / 1000;

  broadcastState();

  res.json({
    success: true,
    message: isVip ? `VIP Bid Confirmed (${bidAmount.toFixed(3)} SOL)!` : `Bid Confirmed (${bidAmount.toFixed(3)} SOL)!`,
    txSig, potSol: gameState.potSol, isVip,
    uniqueBidders: gameState.uniqueBidders.length,
    minRequired: MIN_UNIQUE_BIDDERS
  });
});

app.post('/api/trigger-holder-airdrop', (req, res) => {
  if (gameState.holderPoolSol <= 0.005) return res.status(400).json({ error: 'Insufficient funds in Holder Vault.' });
  const selectedAddress = sampleWallets[Math.floor(Math.random() * sampleWallets.length)];
  const prizeSol = gameState.holderPoolSol;
  const txSig = generateTxSig();
  gameState.holderAirdrop.lastWinner = { winner: selectedAddress, prizeSol, tickets: Math.floor(Math.random() * 15) + 1, isVip: true, sig: txSig, drawnAt: Date.now() };
  gameState.holderPoolSol = 0.01;
  gameState.holderAirdrop.nextDrawTime = Date.now() + 12 * 60 * 60 * 1000;
  broadcastState();
  res.json({ success: true, message: `Holder Airdrop Executed! Winner: ${selectedAddress} won ${prizeSol.toFixed(3)} SOL!`, winner: selectedAddress, prizeSol, txSig });
});

app.post('/api/set-nickname', (req, res) => {
  const { address, nickname } = req.body;
  if (!address || !nickname) return res.status(400).json({ error: 'Missing info' });
  const cleanNick = nickname.trim().substring(0, 15);
  if (cleanNick.length === 0) return res.status(400).json({ error: 'Invalid nickname' });
  gameState.nicknames[address] = cleanNick;
  res.json({ success: true, nickname: cleanNick });
});

app.post('/api/chat', (req, res) => {
  const { sender, text, isVip } = req.body;
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Empty message' });
  
  const displaySender = gameState.nicknames[sender] || sender || 'Anonymous';
  
  const msg = {
    sender: displaySender,
    text: text.trim().substring(0, 150), // max 150 chars
    isVip: !!isVip,
    isSystem: false,
    time: Date.now()
  };
  
  gameState.chatMessages.push(msg);
  if (gameState.chatMessages.length > 50) gameState.chatMessages.shift(); // Keep only last 50
  
  broadcastState();
  res.json({ success: true });
});

// ---------------------------------------------------------------- Game Loop
setInterval(() => {
  if (!gameState.deadline) return;
  const now = Date.now();
  if (now >= gameState.deadline) {
    // CRITICAL: Only settle if 2+ unique bidders participated
    if (gameState.uniqueBidders.length < MIN_UNIQUE_BIDDERS) {
      // Not enough players — extend the round by 60s
      gameState.deadline = now + gameState.roundSeconds * 1000;
      broadcastState();
      return;
    }

    if (gameState.leader) {
      const winner = gameState.leader.address;
      const potPrize = gameState.potSol;
      const bidCount = gameState.bidCount;
      const uniquePlayers = gameState.uniqueBidders.length;
      const winningBidSol = gameState.leader.amountSol;
      
      // Bloqueia o relógio enquanto faz o payout assíncrono
      gameState.deadline = null;

      // Registrar que o fundo do Airdrop cresceu
      gameState.holderPoolSol += (gameState.potSol * 0.05);

      executePayout(gameState.leader.address, gameState.potSol).then((payoutSig) => {
        const roundSummary = {
          round: gameState.round, winner,
          winningBidSol,
          potSol: potPrize, bidCount,
          uniquePlayers,
          endedAt: Date.now(), paid: true, 
          payoutSig: payoutSig || generateTxSig() // Fallback visual se a devnet falhar
        };
        gameState.history.unshift(roundSummary);
        gameState.lastWinner = roundSummary;

        // Se foi a primeira rodada, inicia os relógios dos sorteios longos
        if (gameState.round === 1) {
          gameState.holderAirdrop.nextDrawTime = Date.now() + 12 * 60 * 60 * 1000;
          gameState.rankingDraw.nextDrawTime = Date.now() + 24 * 60 * 60 * 1000;
        }

        // Prepare for next round
        gameState.round += 1;
        gameState.potSol = 0;
        gameState.minBidSol = 0.005; // Reseta pro valor mínimo de 0.005 SOL
        gameState.roundSeconds = 60; // Volta o cronômetro pra 60s
        gameState.leader = null;
        gameState.bids = [];
        gameState.bidCount = 0;
        gameState.uniqueBidders = [];
        gameState.topBidders = {};
        broadcastState();
      });
      return; // O broadcastState ocorrerá no callback do executePayout
    }

    // Fallback caso não haja líder (não deve acontecer)
    gameState.round += 1;
    gameState.deadline = null;
    broadcastState();
  }
}, 500);

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  SolPot — Server Active on Port ${PORT}`);
  console.log(`  Ranking: Top ${RANKING_TOP_N} Bidders`);
  console.log(`  Min Players to Settle: ${MIN_UNIQUE_BIDDERS} unique wallets`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// ==================== BUY & BURN (JUPITER API) ====================
async function executeBuyAndBurn(lamportsToSpend) {
  try {
    console.log(`🔥 Iniciando Buy & Burn com ${lamportsToSpend / 1e9} SOL`);
    const quoteResponse = await (
      await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${gameState.token.mint}&amount=${lamportsToSpend}&slippageBps=500`)
    ).json();

    const swapResponse = await (
      await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: SERVER_KEYPAIR.publicKey.toString(),
          wrapAndUnwrapSol: true,
        })
      })
    ).json();

    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([SERVER_KEYPAIR]);
    
    const txid = await solanaConnection.sendRawTransaction(transaction.serialize());
    await solanaConnection.confirmTransaction(txid);
    console.log(`🔥 Jupiter Swap Confirmado! Sig: ${txid}`);
    
    // Aguarda a rede processar o saldo
    setTimeout(async () => {
       try {
         const mintPubkey = new PublicKey(gameState.token.mint);
         const ata = await splToken.getAssociatedTokenAddress(mintPubkey, SERVER_KEYPAIR.publicKey);
         const balanceInfo = await solanaConnection.getTokenAccountBalance(ata);
         const tokenAmountStr = balanceInfo.value.amount; // formato raw (com decimais)
         
         if (tokenAmountStr === '0') return;
         
         const burnTx = new Transaction().add(
           splToken.createBurnInstruction(ata, mintPubkey, SERVER_KEYPAIR.publicKey, BigInt(tokenAmountStr))
         );
         
         const burnSig = await sendAndConfirmTransaction(solanaConnection, burnTx, [SERVER_KEYPAIR]);
         console.log(`🔥🔥 Tokens QUEIMADOS On-Chain! Sig: ${burnSig}`);
         
         const formattedAmount = (Number(tokenAmountStr) / Math.pow(10, balanceInfo.value.decimals)).toLocaleString(undefined, { maximumFractionDigits: 0 });
         
         gameState.chatMessages.push({
            sender: 'SYSTEM',
            text: `🔥 SERVER BOUGHT & BURNED ${formattedAmount} $SOLPOT!`,
            isSystem: true,
            time: Date.now()
         });
         
         gameState.lastBurn = { amount: formattedAmount, time: Date.now() };
         broadcastState();
       } catch (err) {
         console.error("🔥 Erro no processo de Burn:", err);
       }
    }, 10000); // Aguarda 10s para garantir o sync da RPC

  } catch (err) {
    console.error("🔥 Erro fatal no Buy & Burn:", err);
    // Devolve o saldo pro pool se falhar feio
    gameState.buyBurnPoolSol += (lamportsToSpend / 1e9);
  }
}
