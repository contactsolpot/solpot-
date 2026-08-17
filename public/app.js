const $ = (id) => document.getElementById(id);

let state = null;
let skew = 0;
let walletAddress = null;
let activeProvider = null;

// ---------------------------------------------------------------- Helpers
function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const short = (addr) => (addr && addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr || '');
const sol = (n, dp = 3) => Number(n || 0).toFixed(dp);

function usd(amountSol) {
  if (!state?.solUsd) return '';
  const v = amountSol * state.solUsd;
  return `≈ $${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() + skew - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2800);
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied!`); }
  catch { toast('Copy failed'); }
}

// ---------------------------------------------------------------- Wallet & Stream
async function fetchWalletBalance(pubkeyString) {
  try {
    const res = await fetch(`/api/rpc/balance/${pubkeyString}`);
    const data = await res.json();
    if (data.balance !== undefined) {
      $('sol-balance').textContent = (data.balance / 1e9).toFixed(3);
      $('wallet-balance-display').classList.remove('hidden');
    }
  } catch(e) {
    console.error("Failed to fetch balance", e);
  }
}

// ---------------------------------------------------------------- Wallets
async function connectWallet(providerName) {
  let provider;
  if (providerName === 'phantom') provider = window.solana;
  else if (providerName === 'solflare') provider = window.solflare;
  else if (providerName === 'backpack') provider = window.backpack;

  if (provider && (provider.isPhantom || provider.isSolflare || provider.isBackpack || provider.connect)) {
    try {
      if (provider.isPhantom) {
        const resp = await provider.connect();
        walletAddress = resp.publicKey.toString();
      } else {
        await provider.connect();
        walletAddress = provider.publicKey.toString();
      }
      activeProvider = provider;
      $('wallet-label').textContent = short(walletAddress);
      $('wallet-modal').hidden = true;
      $('btn-disconnect').classList.remove('hidden'); // Show disconnect button
      toast(`${providerName.charAt(0).toUpperCase() + providerName.slice(1)} connected!`);
      fetchWalletBalance(walletAddress);
      checkTokenGate(walletAddress);
    } catch { toast('Connection rejected'); }
  } else {
    toast(`${providerName.charAt(0).toUpperCase() + providerName.slice(1)} not found — please install it.`);
  }
}

$('btn-wallet').onclick = () => {
  $('wallet-modal').hidden = false;
};
$('close-wallet-modal').onclick = () => {
  $('wallet-modal').hidden = true;
};
document.querySelectorAll('.wallet-option').forEach(btn => {
  btn.onclick = () => connectWallet(btn.dataset.wallet);
});

// CA Copy functionality
const caCopyBtn = $('ca-copy-btn');
if (caCopyBtn) {
  caCopyBtn.onclick = () => {
    navigator.clipboard.writeText($('ca-text').textContent).then(() => {
      toast('Contract Address copied!');
    });
  };
}

$('btn-disconnect').onclick = () => {
  if (activeProvider && activeProvider.disconnect) {
    activeProvider.disconnect().catch(()=>{});
  }
  walletAddress = null;
  activeProvider = null;
  $('wallet-label').textContent = 'Connect Wallet';
  $('conn-text').textContent = 'Waiting for Wallet';
  $('conn-dot').className = 'led'; // red
  $('wallet-balance-display').classList.add('hidden');
  $('btn-disconnect').classList.add('hidden');
  $('user-tickets-display').textContent = '0';
  const gs = $('gate-status');
  if (gs) gs.innerHTML = '<span style="color:var(--red);">🔒 Gate Locked</span> — Connect wallet with 10k+ $SOLPOT to play.';
  toast('Wallet disconnected');
};

async function checkTokenGate(addr) {
  try {
    const res = await fetch(`/api/check-holder/${addr}`);
    const data = await res.json();
    if (data.eligible) {
      $('user-tickets-display').textContent = data.tickets;
      const gs = $('gate-status');
      if (gs) gs.innerHTML = `<span style="color:var(--green);font-weight:800;">🔓 Access Granted</span> — ${data.balance.toLocaleString()} $SOLPOT = <strong style="color:var(--gold);">${data.tickets} Ticket(s)</strong>${data.isVip ? ' <strong style="color:var(--gold);">· VIP 25% Discount</strong>' : ''}`;
    }
  } catch {}
}

$('btn-wallet').onclick = () => { $('wallet-modal').hidden = false; };

// ---------------------------------------------------------------- Clock
function paintClock() {
  if (!state) return;

  const card = $('clock-card');
  const clock = $('clock');
  const label = $('clock-label');
  const sub = $('clock-sub');
  const fill = $('clock-fill');
  const suddenBanner = $('sudden-banner');
  const playersNotice = $('players-notice');

  card.classList.remove('hot');

  // Unique players
  const up = $('unique-players');
  if (up) up.textContent = (state.uniqueBidders || []).length;

  // Players notice
  if (playersNotice) {
    const uniqueCount = (state.uniqueBidders || []).length;
    playersNotice.hidden = uniqueCount >= (state.minUniqueBidders || 2);
  }

  const dz = $('danger-zone-alert');

  if (!state.deadline) {
    const playersNeeded = (state.minUniqueBidders || 2) - (state.uniqueBidders || []).length;
    clock.textContent = `${String(state.roundSeconds).padStart(2, '0')}.0`;
    label.textContent = playersNeeded > 0 ? 'WAITING FOR PLAYERS' : 'WAITING FOR BIDS';
    if (sub) sub.textContent = playersNeeded > 0 ? `Need ${playersNeeded} more player(s) to start the clock!` : 'Next bid starts the 60-second clock!';
    if (fill) fill.style.width = '100%';
    if (dz) dz.classList.add('hidden');
    return;
  }

  const left = state.deadline - (Date.now() + skew);

  if (left <= 0) {
    clock.textContent = '00.0';
    label.textContent = 'SETTLING ROUND';
    if (sub) sub.textContent = 'Executing payout on Solana...';
    if (fill) fill.style.width = '0%';
    if (dz) dz.classList.add('hidden');
    return;
  }

  const secs = left / 1000;
  const pct = Math.max(0, Math.min(100, (secs / state.roundSeconds) * 100));
  clock.textContent = secs < 10 ? secs.toFixed(1).padStart(4, '0') : `${String(Math.ceil(secs)).padStart(2, '0')}.0`;
  label.textContent = 'TIME REMAINING';
  if (fill) fill.style.width = `${pct}%`;

  if (secs <= 10) {
    card.classList.add('hot');
    if (sub) sub.textContent = 'Final seconds! Any bid resets the clock!';
    if (dz) dz.classList.remove('hidden');
  } else {
    card.classList.remove('hot');
    if (sub) sub.textContent = `Next bid resets the ${state.roundSeconds}-second clock!`;
    if (dz) dz.classList.add('hidden');
  }

  // --- Side Pool Timers ---
  function formatSideTimer(timeMs) {
    if (!timeMs) return 'Waiting for first round...';
    const l = timeMs - (Date.now() + skew);
    if (l <= 0) return 'Drawing now...';
    const h = Math.floor(l / 3600000);
    const m = Math.floor((l % 3600000) / 60000);
    const s = Math.floor((l % 60000) / 1000);
    return `Draw in: ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  }
  
  const rcd = $('ranking-countdown');
  if (rcd) rcd.textContent = formatSideTimer(state.rankingDraw?.nextDrawTime);
  
  const hcd = $('holder-countdown');
  if (hcd) hcd.textContent = formatSideTimer(state.holderAirdrop?.nextDrawTime);
}

// ---------------------------------------------------------------- Render
function render() {
  if (!state) return;

  $('round-no').textContent = state.round;
  $('pot').textContent = sol(state.potSol);
  $('pot-usd').textContent = usd(state.potSol);

  const lp = $('lucky-pot');
  if (lp) lp.textContent = sol(state.luckyPoolSol);
  const lu = $('lucky-usd');
  if (lu) lu.textContent = usd(state.luckyPoolSol);

  const pp = $('pool-pot');
  if (pp) pp.textContent = sol(state.rankingPoolSol);
  const pu = $('pool-usd');
  if (pu) pu.textContent = usd(state.rankingPoolSol);

  const hp = $('holder-pot');
  if (hp) hp.textContent = sol(state.holderPoolSol);
  const hu = $('holder-usd');
  if (hu) hu.textContent = usd(state.holderPoolSol);

  $('min-bid').textContent = sol(state.minBidSol);
  const mbu = $('min-bid-usd');
  if (mbu) mbu.textContent = usd(state.minBidSol);

  const inp = $('input-bid-amount');
  inp.min = state.minBidSol;
  if (parseFloat(inp.value) < state.minBidSol) inp.value = state.minBidSol;

  const edge = state.potSol - state.minBidSol;
  const be = $('bid-edge');
  if (be) be.textContent = edge > 0 ? `Potential: +${sol(edge)} SOL` : 'Pot scaling up';

  // 🚨 Emergency Pause UI State
  const btnBid = $('btn-bid');
  if (state.isPaused) {
    if (btnBid) {
      btnBid.disabled = true;
      btnBid.innerText = '⚠️ ARENA PAUSED FOR MAINTENANCE';
      btnBid.style.opacity = '0.6';
    }
  } else {
    if (btnBid && btnBid.disabled && btnBid.innerText.includes('PAUSED')) {
      btnBid.disabled = false;
      btnBid.innerText = 'PLACE BID';
      btnBid.style.opacity = '1';
    }
  }

  // Leader
  const addr = $('leader-addr');
  const llink = $('leader-link');

  if (state.leader) {
    addr.textContent = `${short(state.leader.address)} — ${sol(state.leader.amountSol)} SOL${state.leader.isVip ? ' · VIP' : ''}`;
    llink.hidden = false;
    llink.href = `https://solscan.io/tx/${state.leader.sig}`;
  } else {
    addr.textContent = 'Waiting for first bid...';
    llink.hidden = true;
  }

  // Winner banner
  const w = state.lastWinner;
  const wc = $('winner-card');
  if (w && Date.now() + skew - w.endedAt < (state.celebrateMs || 60000)) {
    $('win-round').textContent = w.round;
    $('win-addr').textContent = w.winner;
    $('win-pot').textContent = sol(w.potSol);
    $('win-tx-link').href = `https://solscan.io/tx/${w.payoutSig}`;
    wc.hidden = false;
  } else {
    wc.hidden = true;
  }

  // Lucky draw winner banner
  const lw = state.lastLuckyWinner;
  const lwc = $('lucky-winner-card');
  if (lwc) {
    if (lw && Date.now() + skew - lw.drawnAt < (state.celebrateMs || 60000)) {
      $('lwin-round').textContent = lw.round;
      $('lwin-addr').textContent = lw.winner;
      $('lwin-pot').textContent = sol(lw.prizeSol);
      $('lwin-tx-link').href = `https://solscan.io/tx/${lw.sig}`;
      lwc.hidden = false;
    } else {
      lwc.hidden = true;
    }
  }

  // Holder airdrop winner
  const hw = state.holderAirdrop?.lastWinner;
  const hwc = $('holder-winner-card');
  if (hw && Date.now() + skew - hw.drawnAt < 45000) {
    $('hwin-addr').textContent = hw.winner;
    $('hwin-pot').textContent = sol(hw.prizeSol);
    $('hwin-tickets-info').textContent = `Won with ${hw.tickets || 1} Ticket(s) (${(hw.tickets || 1) * 10}k $SOLPOT)`;
    $('hwin-tx-link').href = `https://solscan.io/tx/${hw.sig}`;
    hwc.hidden = false;
  } else {
    hwc.hidden = true;
  }

  renderRanking();
  renderBids();
  renderWinners();
  renderChat();
  paintClock();
}

function renderRanking() {
  const tbody = $('ranking-body');
  if (!tbody) return;

  const sorted = Object.entries(state.topBidders || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">No bids yet</td></tr>';
    return;
  }

  const totalPool = state.rankingPoolSol || 0;
  const shares = [0.25, 0.18, 0.13, 0.10, 0.08, 0.07, 0.06, 0.05, 0.04, 0.04];

  tbody.innerHTML = sorted.map(([address, totalSol], i) => {
    const shareSol = i < 10 ? totalPool * (shares[i] || 0) : 0;
    return `<tr>
      <td class="ranking-pos">#${i + 1}</td>
      <td><a href="https://solscan.io/account/${address}" target="_blank" rel="noopener">${short(address)}</a></td>
      <td>${sol(totalSol)} SOL</td>
      <td style="color:var(--gold);font-weight:700;">+${sol(shareSol)}</td>
    </tr>`;
  }).join('');
}

function renderBids() {
  const list = $('bid-feed');
  if (!list) return;
  const bc = $('bid-count');
  if (bc) bc.textContent = state.bidCount ? `(${state.bidCount})` : '';

  if (!state.bids?.length) {
    list.innerHTML = '<li class="empty-msg">No bids yet this round.</li>';
    return;
  }

  list.innerHTML = state.bids.map((b, i) => `<li>
    <a href="https://solscan.io/tx/${b.sig}" target="_blank" rel="noopener" title="${b.address}">${short(b.address)}${b.isVip ? ' 👑' : ''}</a>
    <span class="f-right">
      ${i === 0 ? '<span style="color:var(--green);font-size:0.7rem;font-weight:800;">LEADER</span>' : ''}
      <span class="f-amt">${sol(b.amountSol)} SOL</span>
      <span class="f-time">${ago(b.time)}</span>
    </span>
  </li>`).join('');
}

function renderWinners() {
  const list = $('winner-feed');
  if (!list) return;

  if (!state.history?.length) {
    list.innerHTML = '<li class="empty-msg">No rounds finished yet.</li>';
    return;
  }

  list.innerHTML = state.history.map((h) => `<li>
    <a href="https://solscan.io/tx/${h.payoutSig}" target="_blank" rel="noopener">#${h.round} ${short(h.winner)}</a>
    <span class="f-right">
      <span style="color:var(--gold);font-weight:800;font-size:0.7rem;">PAID</span>
      <span class="f-amt">${sol(h.potSol)} SOL</span>
      ${h.luckyWinner ? `<span style="color:var(--cyan);font-weight:700;font-size:0.75rem;" title="Lucky Draw Winner: ${h.luckyWinner.address}">🎲 +${sol(h.luckyWinner.prizeSol)}</span>` : ''}
      <span class="f-time">${ago(h.endedAt)}</span>
    </span>
  </li>`).join('');
}

// ---------------------------------------------------------------- Chat
$('chat-toggle-btn').onclick = () => {
  $('floating-chat').hidden = false;
  $('chat-toggle-btn').hidden = true;
};

$('chat-close-btn').onclick = () => {
  $('floating-chat').hidden = true;
  $('chat-toggle-btn').hidden = false;
};

const btnSetNick = $('btn-set-nickname');
if (btnSetNick) {
  btnSetNick.onclick = async () => {
    if (!walletAddress) {
      toast('Please connect your wallet first!');
      return;
    }
    const nick = prompt('Enter your nickname (max 15 characters):');
    if (!nick || nick.trim() === '') return;
    
    try {
      const res = await fetch('/api/set-nickname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress, nickname: nick })
      });
      const data = await res.json();
      if (data.success) {
        toast(`Nickname set to: ${data.nickname}`);
      } else {
        toast(data.error || 'Failed to set nickname');
      }
    } catch {
      toast('Server error');
    }
  };
}

function formatChatMessage(text) {
  let escaped = escapeHtml(text).replace(/\n/g, '<br/>');
  // Converter links do Solscan em botões clicáveis
  const solscanRegex = /(https:\/\/solscan\.io\/tx\/([a-zA-Z0-9]+))/g;
  return escaped.replace(solscanRegex, '<a href="$1" target="_blank" rel="noopener" class="chat-solscan-pill">🔍 Solscan Tx ↗</a>');
}

function renderChat() {
  const container = $('chat-messages');
  if (!container || !state.chatMessages) return;
  
  const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 10;
  
  container.innerHTML = state.chatMessages.map(m => {
    const formattedText = formatChatMessage(m.text);
    const timeStr = new Date(m.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

    if (m.isBot || (m.isSystem && m.sender.includes('BOT'))) {
      return `<div class="chat-msg bot-msg"><div class="bot-header"><span class="sender bot">${escapeHtml(m.sender)}</span><span class="time">${timeStr}</span></div><div class="text">${formattedText}</div></div>`;
    }
    if (m.isSystem) {
      return `<div class="chat-msg sys-msg"><span class="sender sys">[System]</span><span class="text">${formattedText}</span><span class="time">${timeStr}</span></div>`;
    }
    const vipCls = m.isVip ? 'vip' : '';
    const vipBadge = m.isVip ? ' 👑' : '';
    return `<div class="chat-msg"><span class="sender ${vipCls}">${escapeHtml(short(m.sender))}${vipBadge}:</span><span class="text">${formattedText}</span><span class="time">${timeStr}</span></div>`;
  }).join('');
  
  // Auto-scroll só se o usuário já estava no final do chat
  if (isScrolledToBottom || container.children.length === 1) {
    container.scrollTop = container.scrollHeight;
  }
}

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  
  input.value = '';
  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: walletAddress || 'Anonymous',
        text: text,
        isVip: state.leader?.address === walletAddress && state.leader?.isVip // Check basico VIP
      })
    });
  } catch { toast('Chat offline'); }
}

$('chat-send-btn').onclick = sendChat;
$('chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

// ---------------------------------------------------------------- Bidding
async function sendBid() {
  const amount = parseFloat($('input-bid-amount').value);
  if (isNaN(amount) || amount < state.minBidSol * 0.75) {
    toast(`Min bid: ${sol(state.minBidSol)} SOL`);
    return;
  }

  let bidderAddr = walletAddress;
  
  if (!bidderAddr) {
    toast('Por favor, conecte a sua carteira primeiro!');
    $('wallet-modal').hidden = false;
    return;
  }

  // --- LÓGICA REAL (WEB3.JS) ---
  if (!state.serverWallet) {
    toast('Server wallet not configured yet!');
    return;
  }

  try {
    toast('Aguardando aprovação na carteira...');
    
    const serverWalletPubkey = new solanaWeb3.PublicKey(state.serverWallet);
    const userPubkey = new solanaWeb3.PublicKey(bidderAddr);
    const lamports = Math.floor(amount * 1e9);

    const transaction = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: userPubkey,
        toPubkey: serverWalletPubkey,
        lamports: lamports,
      })
    );

    const bhRes = await fetch('/api/rpc/blockhash');
    const { blockhash, lastValidBlockHeight } = await bhRes.json();
    if (!blockhash) throw new Error("Failed to get blockhash from proxy");

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userPubkey;

    let provider = activeProvider;
    if (!provider) throw new Error("Wallet provider not found");

    const { signature } = await provider.signAndSendTransaction(transaction);
    toast('Transação enviada! Aguardando Confirmação da Blockchain (pode levar alguns segundos)...');
    
    // Desabilitar o botão para prevenir double-clicks enquanto a blockchain processa
    const btn = $('btn-bid');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

    // Enviar a assinatura e os dados do bloco para o servidor aguardar a validação
    const res = await fetch('/api/bid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: bidderAddr, amountSol: amount, sig: signature, blockhash, lastValidBlockHeight })
    });
    
    const data = await res.json();
    toast(data.success ? (data.message || 'Bid Confirmed!') : (data.error || 'Bid failed'));
    
    // Libera o botão
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  } catch (err) {
    console.error(err);
    toast('Transação falhou ou foi rejeitada.');
    const btn = $('btn-bid');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

$('btn-bid').onclick = () => sendBid();

async function triggerHolderAirdrop() {
  try {
    toast('Drawing airdrop...');
    const res = await fetch('/api/trigger-holder-airdrop', { method: 'POST' });
    const data = await res.json();
    toast(data.success ? `Airdrop: ${sol(data.prizeSol)} SOL to ${short(data.winner)}!` : (data.error || 'Draw failed'));
  } catch { toast('Server error'); }
}

const btnDrawHolder = $('btn-draw-holder');
if (btnDrawHolder) btnDrawHolder.onclick = triggerHolderAirdrop;

document.querySelectorAll('.btn-preset').forEach((btn) => {
  btn.onclick = () => {
    const curr = parseFloat($('input-bid-amount').value) || state.minBidSol;
    $('input-bid-amount').value = (curr + parseFloat(btn.dataset.add)).toFixed(3);
  };
});

const copyBtn = $('copy-leader');
if (copyBtn) copyBtn.onclick = () => copy(state?.leader?.address || '', 'Address');

// ---------------------------------------------------------------- Falling Coins
function startRain() {
  const c = $('rain');
  if (!c) return;
  const ctx = c.getContext('2d');
  
  const imgGold = new Image();
  imgGold.src = 'coin_gold.png';
  const imgPurple = new Image();
  imgPurple.src = 'coin_purple.png';

  let coins = [];
  let w, h;

  function resize() {
    w = c.width = window.innerWidth; 
    h = c.height = window.innerHeight;
    const numCoins = Math.min(Math.floor(w / 35), 45); // Max 45 to keep it clean
    coins = Array.from({ length: numCoins }, () => {
      const size = Math.random() * 20 + 20; // 20px to 40px
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        size: size,
        speedY: Math.random() * 1.5 + 0.5,
        speedX: (Math.random() - 0.5) * 0.5,
        img: Math.random() > 0.5 ? imgGold : imgPurple
      };
    });
  }

  function step() {
    ctx.clearRect(0, 0, w, h);

    coins.forEach(coin => {
      if (coin.img.complete) {
        ctx.drawImage(coin.img, coin.x, coin.y, coin.size, coin.size);
      }
      
      coin.y += coin.speedY;
      coin.x += coin.speedX;
      
      if (coin.y > h + 20) {
        coin.y = -coin.size - 20;
        coin.x = Math.random() * w;
      }
    });
    
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(step);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- Music Player
const tracks = [
  { title: "A Sniper's Game", audio: "music/A_Sniper_s_Game.mp3", video: "music/A_Sniper_s_Game.mp4" },
  { title: "Burning the Ledger", audio: "music/Burning_the_Ledger.mp3", video: "music/Burning_the_Ledger.mp4" },
  { title: "Sniper's Last Ten", audio: "music/Sniper_s_Last_Ten.mp3", video: "music/Sniper_s_Last_Ten.mp4" },
  { title: "Sniping the Wire", audio: "music/Sniping_the_Wire.mp3", video: "music/Sniping_the_Wire.mp4" },
  { title: "Ten Seconds to Black", audio: "music/Ten_Seconds_to_Black.mp3", video: "music/Ten_Seconds_to_Black.mp4" },
  { title: "The Sniper's Crown", audio: "music/The_Sniper_s_Crown.mp3", video: "music/The_Sniper_s_Crown.mp4" }
];
let currentTrack = 0;
let isPlaying = false;

const audioEl = $('audio-element');
const videoEl = $('music-video');
const titleEl = $('track-title');
const playBtn = $('play-pause-track');
const volSlider = $('music-volume');

audioEl.volume = volSlider ? volSlider.value : 0.5;
if (volSlider) {
  volSlider.oninput = (e) => { audioEl.volume = e.target.value; };
}

function loadTrack(index) {
  const t = tracks[index];
  audioEl.src = t.audio;
  videoEl.src = t.video;
  titleEl.textContent = t.title;
  if (isPlaying) {
    audioEl.play().catch(()=>{});
    videoEl.play().catch(()=>{});
  }
  updatePlaylistUI();
}

function updatePlaylistUI() {
  const ul = $('playlist-list');
  if (!ul) return;
  ul.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'playlist-item' + (i === currentTrack ? ' active' : '');
    li.innerHTML = `<span class="playlist-item-icon">🎵</span> ${t.title}`;
    li.onclick = () => {
      currentTrack = i;
      if (!isPlaying) {
        isPlaying = true;
        playBtn.innerHTML = '⏸'; playBtn.classList.add('playing');
        $('music-pulse').classList.add('hidden');
      }
      loadTrack(i);
    };
    ul.appendChild(li);
  });
}

$('music-toggle').onclick = () => {
  $('music-panel').classList.toggle('open');
  $('music-pulse').classList.add('hidden'); // Para de piscar após descobrir
};

playBtn.onclick = () => {
  if (isPlaying) {
    audioEl.pause(); videoEl.pause();
    playBtn.innerHTML = '▶'; playBtn.classList.remove('playing');
    $('music-pulse').classList.remove('hidden');
    $('music-pulse').style.borderColor = 'var(--text-3)'; // pulso neutro
  } else {
    audioEl.play(); videoEl.play();
    playBtn.innerHTML = '⏸'; playBtn.classList.add('playing');
    $('music-pulse').classList.add('hidden'); // some quando toca
  }
  isPlaying = !isPlaying;
};

$('next-track').onclick = () => {
  currentTrack = (currentTrack + 1) % tracks.length;
  loadTrack(currentTrack);
};

$('prev-track').onclick = () => {
  currentTrack = (currentTrack - 1 + tracks.length) % tracks.length;
  loadTrack(currentTrack);
};

audioEl.onended = () => $('next-track').onclick();
loadTrack(0);

// ---------------------------------------------------------------- Stream
function apply(next) { 
  // Detect round end (victory/defeat overlay)
  if (state && next.round > state.round && next.lastWinner) {
    showRoundResult(next.lastWinner);
  }

  skew = next.now - Date.now(); 
  
  // --- Burn Toast Logic ---
  if (next.lastBurn && (!state || !state.lastBurn || state.lastBurn.time !== next.lastBurn.time)) {
    const toast = $('burn-toast');
    const amt = $('burn-amount');
    if (toast && amt) {
      amt.textContent = next.lastBurn.amount;
      toast.classList.remove('hidden');
      // trigger reflow for animation
      void toast.offsetWidth;
      toast.classList.add('show');
      
      // hide after 6 seconds
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 500); // Wait for transition
      }, 6000);
    }
  }

  // Final swap
  state = next; 
  render(); 
}

// ---------------------------------------------------------------- Results Modal
function showRoundResult(winnerData) {
  const modal = $('result-modal');
  const content = $('result-content');
  const title = $('result-title');
  const msg = $('result-message');
  const amt = $('result-amount');

  if (!modal) return;
  modal.hidden = false;
  content.className = 'result-modal-content card'; // reset classes
  
  const isMainWinner = walletAddress && winnerData.winner === walletAddress;
  const isLuckyWinner = walletAddress && winnerData.luckyWinner?.address === walletAddress;

  if (isMainWinner) {
    // Main Jackpot Victory
    content.classList.add('victory');
    title.innerHTML = '🎉 YOU WON THE JACKPOT!';
    msg.textContent = 'Incredible! You were the last bidder standing. Payout is being processed directly to your wallet via on-chain smart contract.';
    amt.textContent = `+${Number(winnerData.potSol || 0).toFixed(3)} SOL`;
    amt.hidden = false;
    
    // Victory effects
    new Audio('/victory.mp3').play().catch(() => {});
    const clockPanel = document.querySelector('.clock-panel');
    if (clockPanel) {
      clockPanel.classList.add('timer-flash-green');
      setTimeout(() => clockPanel.classList.remove('timer-flash-green'), 3000);
    }
  } else if (isLuckyWinner) {
    // Lucky Draw Victory
    content.classList.add('lucky-victory');
    title.innerHTML = '🎲 YOU WON THE LUCKY DRAW!';
    msg.textContent = 'Fortune smiled upon you! Your wallet was drawn in the Round Raffle consolation prize!';
    amt.textContent = `+${Number(winnerData.luckyWinner?.prizeSol || 0).toFixed(3)} SOL`;
    amt.style.color = 'var(--cyan)';
    amt.hidden = false;
    
    // Lucky Victory effects
    new Audio('/victory.mp3').play().catch(() => {});
    document.body.classList.add('screen-flash-cyan');
    setTimeout(() => document.body.classList.remove('screen-flash-cyan'), 3000);
  } else {
    // Defeat
    content.classList.add('defeat');
    title.innerHTML = '💀 ROUND ENDED';
    const luckyMsg = winnerData.luckyWinner ? ` and ${short(winnerData.luckyWinner.address)} won the 🎲 Lucky Draw (+${Number(winnerData.luckyWinner.prizeSol || 0).toFixed(3)} SOL)` : '';
    msg.textContent = `The jackpot of ${Number(winnerData.potSol || 0).toFixed(3)} SOL was swept by ${short(winnerData.winner)}${luckyMsg}. Better luck next round!`;
    amt.hidden = true;
    
    // Defeat effects
    new Audio('/defeat.mp3').play().catch(() => {});
    document.body.classList.add('screen-flash-red');
    setTimeout(() => document.body.classList.remove('screen-flash-red'), 2000);
  }
}

$('result-close-btn').onclick = () => {
  $('result-modal').hidden = true;
};

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data));
      $('conn-dot').className = 'led on';
      $('conn-text').textContent = 'Live';
    } catch {}
  };
  es.onerror = () => {
    es.close();
    $('conn-dot').className = 'led';
    $('conn-text').textContent = 'Reconnecting...';
    setTimeout(connectStream, 3000);
  };
}

startRain();
connectStream();
setInterval(paintClock, 100);

// ---------------------------------------------------------------- Security (Disabled for Debugging)
// document.addEventListener('contextmenu', (e) => e.preventDefault());
// document.addEventListener('keydown', (e) => { ... });
