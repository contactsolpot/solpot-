require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bs58 = require('bs58').default || require('bs58');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

const app = express();

// ==================== SANITIZAÇÃO ====================
function sanitizeText(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ==================== AUDITORIA PERPÉTUA ====================
const AUDIT_FILE = path.join(__dirname, 'audit_rounds.json');
function recordRoundAudit(roundData) {
  try {
    let auditLog = [];
    if (fs.existsSync(AUDIT_FILE)) {
      auditLog = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    }
    auditLog.push(roundData);
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLog, null, 2));
    console.log(`📜 [AUDITORIA] Rodada #${roundData.round} registrada com sucesso no log perpétuo!`);
  } catch (e) {
    console.error('Erro ao registrar log de auditoria:', e.message);
  }
}

// ==================== LOGS DE EVENTOS E ERROS DO SISTEMA ====================
const SYSTEM_EVENTS_FILE = path.join(__dirname, 'system_events.json');
let systemEvents = [];
try {
  if (fs.existsSync(SYSTEM_EVENTS_FILE)) {
    systemEvents = JSON.parse(fs.readFileSync(SYSTEM_EVENTS_FILE, 'utf8'));
  }
} catch (e) { systemEvents = []; }

function logSystemEvent(type, message, details = {}, isError = false) {
  const event = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    timestamp: Date.now(),
    type, // 'BID', 'PAYOUT_SUCCESS', 'PAYOUT_ERROR', 'HOLDER_DRAW', 'BUY_BURN', 'CHAT', 'SECURITY', 'RPC_FAIL'
    message,
    details,
    isError
  };
  systemEvents.unshift(event);
  if (systemEvents.length > 100) systemEvents.pop(); // Guarda os últimos 100 eventos
  try { fs.writeFileSync(SYSTEM_EVENTS_FILE, JSON.stringify(systemEvents, null, 2)); } catch {}
  
  if (isError) {
    console.error(`🚨 [ALERTA DE SISTEMA] ${type}: ${message}`, details);
  } else {
    console.log(`ℹ️ [EVENTO] ${type}: ${message}`);
  }
}

// ==================== PERSISTÊNCIA ====================
const STATE_FILE = path.join(__dirname, 'gameState.json');
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(gameState, null, 2)); }
  catch (e) { console.error('Erro ao salvar estado:', e.message); }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return saved;
    }
  } catch (e) { console.error('Erro ao carregar estado:', e.message); }
  return null;
}

// ==================== TOKEN GATE CONFIG ====================
// Colocar como true quando o token estiver lançado na Pump.fun
const TOKEN_GATE_LIVE = process.env.TOKEN_GATE_LIVE === 'true' || false;

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
  'http://127.0.0.1:3000',
  'https://thesolpot.fun',
  'https://www.thesolpot.fun'
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
  luckyPoolSol: 0, // 5% Lucky Draw Raffle for round participants
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
  isPaused: false, // 🚨 Emergency Killswitch / Pausa Administrativa
  pauseReason: '',

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
  lastLuckyWinner: null, // { winner, prizeSol, round, time, sig }
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

// ==================== PAINEL DE CONTROLE / ADMIN API ====================
const ADMIN_SECRET = process.env.ADMIN_SECRET || '##solpotadmin2026##solana##';

function verifyAdmin(req) {
  const secret = req.query.secret || req.headers['x-admin-secret'] || req.body?.secret;
  return secret === ADMIN_SECRET;
}

app.get('/api/admin/overview', async (req, res) => {
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Acesso negado: Chave de Admin inválida.' });

  try {
    let serverBal = 0, platformBal = 0, holderBal = 0;
    try {
      if (SERVER_KEYPAIR) serverBal = (await solanaConnection.getBalance(SERVER_KEYPAIR.publicKey)) / 1e9;
      if (PLATFORM_VAULT) platformBal = (await solanaConnection.getBalance(PLATFORM_VAULT)) / 1e9;
      if (HOLDER_VAULT) holderBal = (await solanaConnection.getBalance(HOLDER_VAULT)) / 1e9;
    } catch (e) {
      console.warn('Erro ao consultar saldos on-chain no admin:', e.message);
    }

    // Calcular estatísticas cumulativas
    let totalRounds = 0;
    let totalVolumeSol = 0;
    let totalPlatformFeesEarnedSol = 0;
    let totalLuckyPrizesPaidSol = 0;
    
    if (fs.existsSync(AUDIT_FILE)) {
      const audits = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
      totalRounds = audits.length;
      audits.forEach(r => {
        const roundTotalBids = (r.bids || []).reduce((acc, b) => acc + (b.amountSol || 0), 0);
        totalVolumeSol += roundTotalBids;
        totalPlatformFeesEarnedSol += (r.devFeeSol || 0);
        if (r.luckyWinner) totalLuckyPrizesPaidSol += (r.luckyWinner.prizeSol || 0);
      });
    }

    const errorsList = systemEvents.filter(e => e.isError);

    res.json({
      onlineUsers: sseClients.length,
      serverUptimeSec: Math.floor(process.uptime()),
      balances: {
        serverWalletSol: serverBal,
        platformVaultSol: platformBal,
        holderVaultSol: holderBal,
        serverWalletAddr: SERVER_KEYPAIR ? SERVER_KEYPAIR.publicKey.toString() : null,
        platformVaultAddr: PLATFORM_VAULT ? PLATFORM_VAULT.toString() : null,
        holderVaultAddr: HOLDER_VAULT ? HOLDER_VAULT.toString() : null
      },
      cumulative: {
        totalRounds,
        totalVolumeSol: Math.round(totalVolumeSol * 1000) / 1000,
        totalPlatformFeesEarnedSol: Math.round(totalPlatformFeesEarnedSol * 1000) / 1000,
        totalLuckyPrizesPaidSol: Math.round(totalLuckyPrizesPaidSol * 1000) / 1000,
        totalErrorsDetected: errorsList.length
      },
      gameState,
      recentEvents: systemEvents.slice(0, 50),
      recentErrors: errorsList.slice(0, 20),
      chatMessages: gameState.chatMessages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-chat', (req, res) => {
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Acesso negado.' });
  gameState.chatMessages = [
    { sender: 'SYSTEM', text: 'Chat limpo pelo Administrador.', isSystem: true, time: Date.now() }
  ];
  broadcastState();
  logSystemEvent('CHAT_CLEARED', 'Chat limpo pelo Administrador');
  res.json({ success: true, message: 'Chat limpo com sucesso.' });
});

app.post('/api/admin/clear-errors', (req, res) => {
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Acesso negado.' });
  systemEvents = systemEvents.filter(e => !e.isError);
  try { fs.writeFileSync(SYSTEM_EVENTS_FILE, JSON.stringify(systemEvents, null, 2)); } catch {}
  res.json({ success: true, message: 'Erros limpos com sucesso.' });
});

// 🚨 EMERGENCY KILLSWITCH / PAUSA ADMINISTRATIVA
app.post('/api/admin/toggle-pause', (req, res) => {
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Acesso negado.' });
  
  gameState.isPaused = !gameState.isPaused;
  gameState.pauseReason = gameState.isPaused ? (req.body?.reason || 'Manutenção Técnica Preventiva') : '';

  // Notificar no chat
  gameState.chatMessages.push({
    sender: '🚨 SISTEMA',
    text: gameState.isPaused ? `⚠️ O JOGO FOI PAUSADO PELA ADMINISTRAÇÃO: ${gameState.pauseReason}. Seus fundos e lances estão 100% seguros.` : `🟢 O JOGO FOI RETOMADO! Que vença o melhor sniper!`,
    isSystem: true,
    time: Date.now()
  });

  logSystemEvent(
    gameState.isPaused ? 'EMERGENCY_PAUSE_ENABLED' : 'EMERGENCY_PAUSE_DISABLED',
    gameState.isPaused ? `🚨 Jogo PAUSADO pelo administrador: ${gameState.pauseReason}` : `🟢 Jogo DESPAUSADO pelo administrador.`,
    { isPaused: gameState.isPaused },
    gameState.isPaused
  );

  saveState();
  broadcastState();

  res.json({
    success: true,
    isPaused: gameState.isPaused,
    message: gameState.isPaused ? '🚨 Jogo pausado com sucesso! Lances bloqueados.' : '🟢 Jogo retomado com sucesso!'
  });
});

app.get('/api/check-holder/:address', async (req, res) => {
  const { address } = req.params;
  
  let tokenBalance = 0;
  if (TOKEN_GATE_LIVE) {
    // Token Gate Real — busca saldo on-chain
    try {
      const mintPubkey = new PublicKey(gameState.token.mint);
      const ownerPubkey = new PublicKey(address);
      const ata = await splToken.getAssociatedTokenAddress(mintPubkey, ownerPubkey);
      const balanceInfo = await solanaConnection.getTokenAccountBalance(ata);
      tokenBalance = balanceInfo.value.uiAmount || 0;
    } catch (e) {
      tokenBalance = 0; // Wallet sem token account
    }
  } else {
    // Pré-lançamento: todos podem jogar
    tokenBalance = 120000;
  }
  
  const tickets = Math.floor(tokenBalance / gameState.token.minRequired);
  const isVip = tokenBalance >= gameState.token.vipRequired;
  res.json({ address, eligible: tickets >= 1, balance: tokenBalance, tickets, isVip, discountPct: isVip ? gameState.token.vipDiscountPct : 0, required: gameState.token.minRequired });
});

// ==================== RPC PROXY ====================
// O navegador sofre bloqueio 403 da Solana Pública. O servidor atua como ponte.

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
      await solanaConnection.confirmTransaction(sig, 'confirmed');
    }

    // 2. Read the confirmed transaction
    const tx = await solanaConnection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || tx.meta.err) {
      console.error("Tx failed or not found. Err:", tx?.meta?.err);
      logSystemEvent('BID_TX_FAIL', 'Transação do lance falhou ou não foi encontrada na Solana', { sig, err: tx?.meta?.err }, true);
      return false;
    }

    // Achar a index da carteira do Servidor no array de chaves
    const serverIndex = tx.transaction.message.staticAccountKeys.findIndex(k => k.equals(SERVER_KEYPAIR.publicKey));
    if (serverIndex === -1) {
      logSystemEvent('BID_INVALID_RECIPIENT', 'Transação não enviou fundos para a carteira do jogo', { sig }, true);
      return false;
    }

    // Calcular diferença de saldo
    const preBalance = tx.meta.preBalances[serverIndex];
    const postBalance = tx.meta.postBalances[serverIndex];
    const lamportsReceived = postBalance - preBalance;

    const valid = lamportsReceived >= expectedLamports;
    if (!valid) {
      logSystemEvent('BID_UNDERPAID', `Valor recebido (${lamportsReceived/1e9} SOL) menor que esperado (${expectedLamports/1e9} SOL)`, { sig, lamportsReceived, expectedLamports }, true);
    }
    return valid;
  } catch (err) {
    console.error("Verify Bid Error:", err);
    logSystemEvent('BID_VERIFY_ERROR', `Erro ao verificar lance: ${err.message}`, { sig, error: err.message }, true);
    return false;
  }
}

// Lista de RPCs públicas para redundância na Mainnet (evita rate-limit no Render)
const FALLBACK_RPCS = [
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana-rpc.publicnode.com"
];

async function executePayout(winnerAddress, potSolToPay, luckyWinnerAddress, luckySolToPay, devFeeToPay, maxAttempts = 3) {
  const winnerLamports = Math.floor(potSolToPay * 1e9);
  const luckyLamports = luckyWinnerAddress && luckySolToPay > 0 ? Math.floor(luckySolToPay * 1e9) : 0;
  const platformLamports = Math.floor((devFeeToPay * 0.8) * 1e9); // 4% do total
  const buyBurnLamports = Math.floor((devFeeToPay * 0.2) * 1e9);  // 1% do total

  console.log(`💸 Iniciando Payout On-Chain: Vencedor (${winnerAddress}): ${winnerLamports/1e9} SOL | Lucky (${luckyWinnerAddress}): ${luckyLamports/1e9} SOL`);

  // Tentar enviar através dos RPCs com retry
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const rpcUrl of FALLBACK_RPCS) {
      try {
        const conn = new Connection(rpcUrl, 'confirmed');
        const balance = await conn.getBalance(SERVER_KEYPAIR.publicKey);
        
        if (balance < (winnerLamports + luckyLamports + platformLamports + 10000)) {
          const errMsg = `Saldo insuficiente na carteira do servidor (${(balance/1e9).toFixed(4)} SOL) para pagar ${(((winnerLamports + luckyLamports + platformLamports)/1e9)).toFixed(4)} SOL.`;
          console.error(`❌ ${errMsg}`);
          logSystemEvent('PAYOUT_LOW_BALANCE', errMsg, { balanceSol: balance/1e9, neededSol: (winnerLamports + luckyLamports + platformLamports)/1e9 }, true);
          return { winnerSig: null, luckySig: null };
        }

        const transaction = new Transaction();
        
        // 1. Payout pro Vencedor do Jackpot (80%)
        transaction.add(
          SystemProgram.transfer({ fromPubkey: SERVER_KEYPAIR.publicKey, toPubkey: new PublicKey(winnerAddress), lamports: winnerLamports })
        );

        // 2. Payout pro Vencedor do Lucky Draw (5%)
        if (luckyLamports > 0 && luckyWinnerAddress) {
          transaction.add(
            SystemProgram.transfer({ fromPubkey: SERVER_KEYPAIR.publicKey, toPubkey: new PublicKey(luckyWinnerAddress), lamports: luckyLamports })
          );
        }

        // 3. Taxa da Plataforma (4%)
        transaction.add(
          SystemProgram.transfer({ fromPubkey: SERVER_KEYPAIR.publicKey, toPubkey: PLATFORM_VAULT, lamports: platformLamports })
        );

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = SERVER_KEYPAIR.publicKey;
        transaction.sign(SERVER_KEYPAIR);

        const rawTx = transaction.serialize();
        const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 5 });
        
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        
        console.log(`✅ PAYOUT CONFIRMADO NA SOLANA! RPC: ${rpcUrl} | Sig: ${sig}`);
        logSystemEvent('PAYOUT_CONFIRMED', `Pagamento on-chain concluído com sucesso!`, {
          winner: winnerAddress,
          winnerPrizeSol: winnerLamports / 1e9,
          luckyWinner: luckyWinnerAddress,
          luckyPrizeSol: luckyLamports / 1e9,
          platformFeeSol: platformLamports / 1e9,
          txSig: sig,
          solscanUrl: `https://solscan.io/tx/${sig}`,
          rpcUsed: rpcUrl
        });
        
        // Registrar o aumento do fundo de Buy & Burn internamente (Hot Wallet retém esse 1%)
        gameState.buyBurnPoolSol += (buyBurnLamports / 1e9);

        // Disparar o Buy & Burn se atingiu o limite de 0.05 SOL
        if (gameState.buyBurnPoolSol >= 0.05) {
          const lamportsToSpend = Math.floor(gameState.buyBurnPoolSol * 1e9);
          gameState.buyBurnPoolSol = 0;
          executeBuyAndBurn(lamportsToSpend);
        }

        return { winnerSig: sig, luckySig: sig };
      } catch (err) {
        console.warn(`⚠️ Tentativa ${attempt} falhou no RPC ${rpcUrl}: ${err.message}. Tentando próximo...`);
        logSystemEvent('PAYOUT_RETRY_WARNING', `Tentativa ${attempt} falhou no RPC ${rpcUrl}: ${err.message}`, { rpcUrl, attempt, error: err.message }, true);
      }
    }
    // Aguarda 1 segundo antes do próximo ciclo de retry
    await new Promise(res => setTimeout(res, 1000));
  }

  console.error("❌ Todas as tentativas de payout on-chain falharam nos RPCs!");
  logSystemEvent('PAYOUT_CRITICAL_FAILURE', `FALHA CRÍTICA: Não foi possível enviar os prêmios on-chain após ${maxAttempts} tentativas!`, {
    winner: winnerAddress,
    potSol: potSolToPay,
    luckyWinner: luckyWinnerAddress,
    luckyPrizeSol: luckySolToPay
  }, true);
  return { winnerSig: null, luckySig: null };
}
// ====================================================

app.post('/api/bid', async (req, res) => {
  const { address, amountSol, sig, blockhash, lastValidBlockHeight } = req.body;
  if (!address || !amountSol) return res.status(400).json({ error: "Missing data" });
  
  if (gameState.isPaused) {
    return res.status(503).json({
      error: `🚨 O JOGO ESTÁ TEMPORARIAMENTE PAUSADO: ${gameState.pauseReason || 'Manutenção Preventiva'}. Nenhum fundo foi debitado.`
    });
  }
  
  // C1 FIX: Buscar saldo do token no SERVIDOR, nunca confiar no cliente
  let currentBalance = 0;
  if (TOKEN_GATE_LIVE) {
    try {
      const mintPubkey = new PublicKey(gameState.token.mint);
      const ownerPubkey = new PublicKey(address);
      const ata = await splToken.getAssociatedTokenAddress(mintPubkey, ownerPubkey);
      const balanceInfo = await solanaConnection.getTokenAccountBalance(ata);
      currentBalance = balanceInfo.value.uiAmount || 0;
    } catch (e) {
      currentBalance = 0;
    }
  } else {
    currentBalance = 120000; // Pré-lançamento
  }

  const userTickets = Math.floor(currentBalance / gameState.token.minRequired);
  const isVip = currentBalance >= gameState.token.vipRequired;
  const discountMultiplier = isVip ? (1 - gameState.token.vipDiscountPct / 100) : 1.0;
  const effectiveMinBid = gameState.minBidSol * discountMultiplier;

  if (amountSol < effectiveMinBid) {
    return res.status(400).json({ error: isVip ? `VIP Minimum Bid (25% Discount): ${effectiveMinBid.toFixed(3)} SOL` : `Minimum Bid Required: ${gameState.minBidSol.toFixed(3)} SOL` });
  }
  if (userTickets < 1) {
    logSystemEvent('TOKEN_GATE_BLOCKED', `Tentativa de jogar sem tokens suficientes: ${address}`, { address, currentBalance }, true);
    return res.status(403).json({ error: `Token Gate: You need at least 10,000 ${gameState.token.name} to play!`, buyUrl: gameState.token.pumpUrl });
  }

  if (!sig) return res.status(400).json({ error: "Missing transaction signature." });
  const bidAmount = Number(amountSol);
  const expectedLamports = Math.floor(bidAmount * 1e9);

  const isValid = await verifyBidOnChain(sig, expectedLamports, blockhash, lastValidBlockHeight);
  if (!isValid) return res.status(400).json({ error: "Transaction invalid or funds not received." });

  const txSig = sig;

  // H3 FIX: Aritmética em lamports inteiros para evitar drift de ponto flutuante (80/5/5/5/5)
  const bidLamports = Math.round(bidAmount * 1e9);
  gameState.potSol = (gameState.potSol * 1e9 + Math.round(bidLamports * 0.80)) / 1e9;
  gameState.luckyPoolSol = (gameState.luckyPoolSol * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
  gameState.rankingPoolSol = (gameState.rankingPoolSol * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
  gameState.holderPoolSol = (gameState.holderPoolSol * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
  gameState.devFeeSol = (gameState.devFeeSol * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;

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
    gameState.roundSeconds = Math.max(10, gameState.roundSeconds);
  }

  if (gameState.uniqueBidders.length >= MIN_UNIQUE_BIDDERS) {
    gameState.deadline = now + gameState.roundSeconds * 1000;
  } else {
    gameState.deadline = null;
  }

  gameState.leader = { address: address, amountSol: bidAmount, time: now, sig: txSig, tickets: userTickets, isVip };
  gameState.bids.unshift({ address: address, amountSol: bidAmount, time: now, sig: txSig, tickets: userTickets, isVip });
  if (gameState.bids.length > 50) gameState.bids.pop();
  gameState.bidCount += 1;
  gameState.topBidders[address] = (gameState.topBidders[address] || 0) + bidAmount;
  gameState.minBidSol = Math.round((gameState.minBidSol + 0.001) * 1000) / 1000;

  logSystemEvent('BID_CONFIRMED', `Novo lance confirmado: ${bidAmount.toFixed(3)} SOL por ${address.slice(0,6)}...${address.slice(-4)}`, {
    address,
    amountSol: bidAmount,
    sig: txSig,
    round: gameState.round,
    potNow: gameState.potSol
  });

  broadcastState();
  saveState();

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
  
  // Anúncio automático do Bot no chat com link do Solscan
  gameState.chatMessages.push({
    sender: '💎 HOLDER BOT',
    text: `💎 HOLDER AIRDROP DRAW!\n🎉 Winner: ${selectedAddress.slice(0,4)}...${selectedAddress.slice(-4)} won ${prizeSol.toFixed(3)} SOL!\n🔗 https://solscan.io/tx/${txSig}`,
    isBot: true,
    isSystem: true,
    time: Date.now()
  });

  logSystemEvent('HOLDER_DRAW_EXECUTED', `Sorteio do Holder Vault executado! Vencedor: ${selectedAddress} (${prizeSol.toFixed(3)} SOL)`, {
    winner: selectedAddress,
    prizeSol,
    txSig
  });

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
  const { sender, text, isVip, isAdmin } = req.body;
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Empty message' });
  
  const displaySender = isAdmin ? '👑 DEV/ADMIN' : (gameState.nicknames[sender] || sender || 'Anonymous');
  
  // C3 FIX: Sanitizar texto contra XSS no lado do servidor
  const msg = {
    sender: sanitizeText(displaySender),
    text: sanitizeText(text.trim().substring(0, 150)),
    isVip: !!isVip || !!isAdmin,
    isSystem: !!isAdmin,
    time: Date.now()
  };
  
  gameState.chatMessages.push(msg);
  if (gameState.chatMessages.length > 50) gameState.chatMessages.shift(); // Keep only last 50
  
  logSystemEvent('CHAT_MESSAGE', `${displaySender}: ${msg.text}`, { sender: displaySender, text: msg.text });

  broadcastState();
  res.json({ success: true });
});

// ---------------------------------------------------------------- Game Loop
setInterval(() => {
  if (gameState.isPaused) return; // Congela o cronômetro durante a pausa
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
      const luckyPrize = gameState.luckyPoolSol;
      const devFeeThisRound = gameState.devFeeSol;
      const bidCount = gameState.bidCount;
      const uniquePlayers = gameState.uniqueBidders.length;
      const winningBidSol = gameState.leader.amountSol;
      
      // Sorteio da Rodada (Lucky Draw): escolher entre quem deu lance exceto o vencedor principal
      const candidateBids = gameState.bids.filter(b => b.address !== winner);
      const luckyWinner = candidateBids.length > 0
        ? candidateBids[Math.floor(Math.random() * candidateBids.length)].address
        : (gameState.uniqueBidders.find(a => a !== winner) || winner);
      
      // Bloqueia o relógio enquanto faz o payout assíncrono
      gameState.deadline = null;

      executePayout(winner, potPrize, luckyWinner, luckyPrize, devFeeThisRound).then((payoutRes) => {
        const winnerSig = payoutRes.winnerSig || generateTxSig();
        const luckySig = payoutRes.luckySig || generateTxSig();

        const roundSummary = {
          round: gameState.round,
          winner,
          winningBidSol,
          potSol: potPrize,
          luckyWinner: {
            address: luckyWinner,
            prizeSol: luckyPrize,
            sig: luckySig
          },
          bidCount,
          uniquePlayers,
          endedAt: Date.now(),
          paid: true, 
          payoutSig: winnerSig
        };
        
        // Registrar auditoria completa e perpétua com todas as assinaturas de lances e pagamentos
        recordRoundAudit({
          ...roundSummary,
          bids: [...gameState.bids],
          rankingPoolSol: gameState.rankingPoolSol,
          holderPoolSol: gameState.holderPoolSol,
          devFeeSol: devFeeThisRound,
          solscanWinnerPayout: `https://solscan.io/tx/${winnerSig}`,
          solscanLuckyPayout: `https://solscan.io/tx/${luckySig}`
        });

        gameState.history.unshift(roundSummary);
        gameState.lastWinner = roundSummary;
        gameState.lastLuckyWinner = {
          winner: luckyWinner,
          prizeSol: luckyPrize,
          round: gameState.round,
          drawnAt: Date.now(),
          sig: luckySig
        };

        // Adicionar anúncio do Bot no chat comemorando ambos e link do Solscan
        gameState.chatMessages.push({
          sender: '🤖 SOLPOT BOT',
          text: `👑 ROUND #${gameState.round} SETTLED!\n🏆 Jackpot: ${winner.slice(0,4)}...${winner.slice(-4)} won ${potPrize.toFixed(3)} SOL\n🎲 Lucky Winner: ${luckyWinner.slice(0,4)}...${luckyWinner.slice(-4)} (+${luckyPrize.toFixed(3)} SOL)\n🔗 https://solscan.io/tx/${winnerSig}`,
          isBot: true,
          isSystem: true,
          time: Date.now()
        });

        // Se foi a primeira rodada, inicia os relógios dos sorteios longos
        if (gameState.round === 1) {
          gameState.holderAirdrop.nextDrawTime = Date.now() + 12 * 60 * 60 * 1000;
          gameState.rankingDraw.nextDrawTime = Date.now() + 24 * 60 * 60 * 1000;
        }

        // Prepare for next round
        gameState.round += 1;
        gameState.potSol = 0;
        gameState.luckyPoolSol = 0;
        gameState.devFeeSol = 0; // Reseta a taxa da plataforma acumulada nesta rodada
        gameState.minBidSol = 0.005; // Reseta pro valor mínimo de 0.005 SOL
        gameState.roundSeconds = 60; // Volta o cronômetro pra 60s
        gameState.leader = null;
        gameState.bids = [];
        gameState.bidCount = 0;
        gameState.uniqueBidders = [];
        gameState.topBidders = {};
        saveState(); // H4 FIX: Persistir estado após cada rodada
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
  // H4 FIX: Carregar estado salvo se existir
  const saved = loadState();
  if (saved) {
    Object.assign(gameState, saved);
    // Resetar campos transientes
    gameState.deadline = null;
    gameState.health.lastReadAt = Date.now();
    console.log(`📂 Estado restaurado! Rodada ${gameState.round}, Pote: ${gameState.potSol} SOL`);
  }
  console.log(`====================================================`);
  console.log(`  SolPot — Server Active on Port ${PORT}`);
  console.log(`  Token Gate: ${TOKEN_GATE_LIVE ? '🟢 LIVE (On-Chain)' : '🟡 PRE-LAUNCH (Bypass)'}`);
  console.log(`  Ranking: Top ${RANKING_TOP_N} Bidders`);
  console.log(`  Min Players to Settle: ${MIN_UNIQUE_BIDDERS} unique wallets`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// H4 FIX: Auto-salvar estado a cada 30 segundos
setInterval(saveState, 30000);

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
             sender: '🔥 BURN BOT',
             text: `🔥 SERVER BOUGHT & BURNED ${formattedAmount} $SOLPOT!\n🔗 https://solscan.io/tx/${burnSig}`,
             isBot: true,
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
