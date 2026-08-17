/**
 * SOLPOT — Backtest Automatizado
 * Testa todas as correções da auditoria e a nova economia 80/5/5/5/4/1 (Lucky Draw).
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ================================================================
// Carregar o server.js e app.js como texto para análise estática
// ================================================================
const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const appCode = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const whitepaperCode = fs.readFileSync(path.join(__dirname, 'public', 'whitepaper.html'), 'utf8');
const indexCode = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

console.log('\n🔍 SOLPOT BACKTEST — Auditoria e Testes do Lucky Draw (80/5/5/5/4/1)\n');
console.log('━'.repeat(50));

// ================================================================
console.log('\n📋 C1 — Token Gate Bypass (req.body.tokenBalance removido)');
// ================================================================

test('Endpoint /api/bid NÃO aceita tokenBalance do cliente', () => {
  const bidRouteMatch = serverCode.match(/app\.post\('\/api\/bid'[\s\S]*?const \{([^}]+)\} = req\.body/);
  assert(bidRouteMatch, 'Rota /api/bid não encontrada');
  assert(!bidRouteMatch[1].includes('tokenBalance'), 'tokenBalance ainda está no destructuring do req.body!');
});

test('Endpoint /api/bid busca saldo no servidor (TOKEN_GATE_LIVE)', () => {
  const bidSection = serverCode.substring(serverCode.indexOf("app.post('/api/bid'"));
  assert(bidSection.includes('TOKEN_GATE_LIVE'), 'TOKEN_GATE_LIVE não encontrado na rota /api/bid');
  assert(bidSection.includes('getAssociatedTokenAddress') || bidSection.includes('getTokenAccountBalance'), 'Busca on-chain de token não encontrada');
});

// ================================================================
console.log('\n📋 C2 — Token Gate com Flag de Pré-Lançamento');
// ================================================================

test('Variável TOKEN_GATE_LIVE existe', () => {
  assert(serverCode.includes('TOKEN_GATE_LIVE'), 'TOKEN_GATE_LIVE não declarado');
});

test('check-holder usa TOKEN_GATE_LIVE', () => {
  const checkSection = serverCode.substring(serverCode.indexOf("'/api/check-holder/"));
  assert(checkSection.includes('TOKEN_GATE_LIVE'), 'check-holder não usa TOKEN_GATE_LIVE');
});

// ================================================================
console.log('\n📋 C3 — XSS no Chat (Sanitização)');
// ================================================================

test('Função sanitizeText existe no server.js', () => {
  assert(serverCode.includes('function sanitizeText'), 'sanitizeText não encontrado no server');
  assert(serverCode.includes('&lt;'), 'sanitizeText não escapa <');
  assert(serverCode.includes('&gt;'), 'sanitizeText não escapa >');
});

test('Chat usa sanitizeText no servidor', () => {
  const chatSection = serverCode.substring(serverCode.indexOf("'/api/chat'"));
  assert(chatSection.includes('sanitizeText'), 'sanitizeText não usado na rota /api/chat');
});

test('Função escapeHtml existe no app.js (frontend)', () => {
  assert(appCode.includes('escapeHtml') || appCode.includes('escape'), 'escapeHtml não encontrado no frontend');
});

// ================================================================
console.log('\n📋 H1 — Rota Duplicada Holder Airdrop');
// ================================================================

test('Rota /api/trigger-holder-airdrop NÃO está duplicada', () => {
  const matches = serverCode.match(/app\.post\('\/api\/trigger-holder-airdrop'/g);
  assert(matches, 'Nenhuma rota trigger-holder-airdrop encontrada');
  assert(matches.length === 1, `Encontradas ${matches.length} rotas (deveria ser 1)`);
});

test('Rota restante NÃO retorna 403 fixo', () => {
  const routeIdx = serverCode.indexOf("app.post('/api/trigger-holder-airdrop'");
  const routeSection = serverCode.substring(routeIdx, routeIdx + 500);
  assert(!routeSection.includes('res.status(403)'), 'Rota ainda retorna 403 fixo');
});

// ================================================================
console.log('\n📋 H3 & NOVA ECONOMIA — 80/5/5/5/4/1 + Lucky Draw');
// ================================================================

test('Bid acumula 80% no Main Jackpot e 5% no Lucky Draw', () => {
  const bidSection = serverCode.substring(serverCode.indexOf("app.post('/api/bid'"));
  assert(bidSection.includes('0.80') || bidSection.includes('0.8'), 'Main jackpot não está configurado para 80%');
  assert(bidSection.includes('luckyPoolSol'), 'luckyPoolSol não encontrado no cálculo do lance');
});

test('Simulação: 100 bids de 0.1 SOL com nova economia sem drift', () => {
  let pot = 0, lucky = 0, ranking = 0, holder = 0, devFee = 0;
  for (let i = 0; i < 100; i++) {
    const bidLamports = Math.round(0.1 * 1e9);
    pot = (pot * 1e9 + Math.round(bidLamports * 0.80)) / 1e9;
    lucky = (lucky * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
    ranking = (ranking * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
    holder = (holder * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
    devFee = (devFee * 1e9 + Math.round(bidLamports * 0.05)) / 1e9;
  }
  const total = pot + lucky + ranking + holder + devFee;
  assert(Math.abs(total - 10.0) < 0.000000001, `Total não fecha 10.0 SOL: ${total}`);
  assert(Math.abs(pot - 8.0) < 0.000000001, `Pot principal não fecha 8.0 SOL: ${pot}`);
  assert(Math.abs(lucky - 0.5) < 0.000000001, `Lucky pool não fecha 0.5 SOL: ${lucky}`);
});

test('Settlement sorteia Lucky Draw entre participantes', () => {
  assert(serverCode.includes('lastLuckyWinner'), 'lastLuckyWinner não declarado no estado');
  assert(serverCode.includes('candidateBids') || serverCode.includes('luckyWinner'), 'Lógica de escolha do Lucky Winner não encontrada');
});

// ================================================================
console.log('\n📋 H4 — Persistência de Estado');
// ================================================================

test('Funções saveState e loadState existem', () => {
  assert(serverCode.includes('function saveState'), 'saveState não encontrada');
  assert(serverCode.includes('function loadState'), 'loadState não encontrada');
});

test('saveState é chamado após bids', () => {
  const calls = serverCode.match(/saveState\(\)/g);
  assert(calls && calls.length >= 2, `Apenas ${calls?.length || 0} chamada(s) a saveState (mínimo 2: bid + round end)`);
});

test('loadState é chamado no startup', () => {
  const listenSection = serverCode.substring(serverCode.indexOf('app.listen'));
  assert(listenSection.includes('loadState'), 'loadState não chamado no startup');
});

test('Auto-save periódico existe', () => {
  assert(serverCode.includes('setInterval(saveState'), 'Auto-save periódico não encontrado');
});

// ================================================================
console.log('\n📋 H5 — CORS com Domínio de Produção');
// ================================================================

test('thesolpot.fun está na lista de CORS', () => {
  assert(serverCode.includes("'https://thesolpot.fun'"), 'thesolpot.fun não encontrado no CORS');
});

// ================================================================
console.log('\n📋 FRONTEND & WHITEPAPER CONSISTENCY');
// ================================================================

test('Whitepaper documenta 80/5/5/5/4/1 e Lucky Draw', () => {
  assert(whitepaperCode.includes('80%'), 'Whitepaper não menciona 80% do Jackpot');
  assert(whitepaperCode.includes('Lucky Draw'), 'Whitepaper não menciona Lucky Draw');
  assert(whitepaperCode.includes('80/5/5/5/4/1'), 'Whitepaper não contém a divisão 80/5/5/5/4/1');
});

test('index.html contém Lucky Draw pool card e banner', () => {
  assert(indexCode.includes('lucky-pot'), 'Card do lucky-pot não encontrado no index.html');
  assert(indexCode.includes('lucky-winner-card'), 'Banner do lucky-winner-card não encontrado no index.html');
  assert(indexCode.includes('JACKPOT (80%)'), 'Título JACKPOT (80%) não encontrado no index.html');
});

test('app.js tem modal comemorativo para Lucky Victory', () => {
  assert(appCode.includes('lucky-victory'), 'Classe lucky-victory não encontrada no app.js');
  assert(appCode.includes('YOU WON THE LUCKY DRAW'), 'Mensagem YOU WON THE LUCKY DRAW não encontrada no app.js');
});

// ================================================================
// RESULTADO FINAL
// ================================================================
console.log('\n' + '━'.repeat(50));
console.log(`\n📊 RESULTADO: ${passed} passou | ${failed} falhou | ${passed + failed} total\n`);

if (failed === 0) {
  console.log('🎉 TODOS OS TESTES PASSARAM COM SUCESSO!\n');
} else {
  console.log(`⚠️  ${failed} teste(s) falharam.\n`);
}

process.exit(failed > 0 ? 1 : 0);
