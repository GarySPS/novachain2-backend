// routes/prices.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// --- Config ---
const TWELVE_API_KEY = process.env.TWELVE_API_KEY; // Read Twelve Data key from .env

const CG_ID = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  ethereum: "ethereum",
  eth: "ethereum",
  tether: "tether",
  usdt: "tether",
  solana: "solana",
  sol: "solana",
  ripple: "ripple",
  xrp: "ripple",
  toncoin: "the-open-network",
  ton: "the-open-network",
};

// --- Commodity Symbols for Twelve Data ---
const TWELVE_SYMBOL = {
  xau: "XAU/USD",
  xag: "XAG/USD",
  wti: "WTI/USD",
  natgas: "NG/USD",
  xcu: "XCU/USD",
};

// Helper to check if it's a known Forex/Commodity
function isForexOrCommodity(apiSymbol) {
    return !!TWELVE_SYMBOL[apiSymbol?.toLowerCase()];
}

// Helper to check if it's a known Crypto for CoinGecko
function isCrypto(apiSymbol) {
    return !!CG_ID[apiSymbol?.toLowerCase()];
}

// --- Caches ---
const symbolCache = {};
const LIST_REFRESH_MS = 3000;
const SYMBOL_STALE_OK_MS = 5 * 60_000;

// --- Routes ---

/* GET /api/prices/:symbol - Handles Crypto, Forex, and Commodities */
router.get("/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toLowerCase();

    const map = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  tether: "USDTUSDT",
  solana: "SOLUSDT",
  ripple: "XRPUSDT",
  toncoin: "TONUSDT",
};

    const pair = map[symbol];
    if (!pair) {
      return res.status(400).json({ error: "Unsupported symbol" });
    }

    // ✅ Binance FIRST (FAST)
    try {
      const r = await axios.get(
        `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
        { timeout: 3000 }
      );

      return res.json({
        price: Number(r.data.price),
        source: "binance",
      });
    } catch (e) {
      console.log("Binance failed, fallback to CoinGecko");
    }

    // ✅ Fallback (only if Binance fails)
    try {
      const cg = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`,
        { timeout: 5000 }
      );

      const price = cg.data?.[symbol]?.usd;
      if (!price) throw new Error("No CG price");

      return res.json({
        price: Number(price),
        source: "coingecko",
      });
    } catch (e) {
      return res.status(500).json({ error: "Price fetch failed" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* GET /api/prices - Fetches the list of top cryptocurrencies */
router.get("/", async (req, res) => {
  const now = Date.now();
  const limit = Math.min(parseInt(req.query.limit) || 100, 100);

  console.log(`Received price list request with limit: ${limit}`);

  // Simple in-memory cache
  if (global.__priceListCache && global.__priceListCache.data.length > 0 && now - global.__priceListCache.t < 10000) {
    console.log(`Serving cached list data`);
    return res.json({ data: global.__priceListCache.data.slice(0, limit) });
  }

  try {
    const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`;
    console.log(`Fetching CoinGecko market list from: ${cgUrl}`);

    const { data: cgDataArr } = await axios.get(cgUrl, { 
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'NovaChain/1.0'
      }
    });

    if (!cgDataArr || !Array.isArray(cgDataArr)) {
      throw new Error("Invalid data received from CoinGecko markets endpoint");
    }

    const formattedData = cgDataArr.map(coin => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol.toUpperCase(),
        cmc_rank: coin.market_cap_rank,
        quote: {
            USD: {
                price: coin.current_price,
                volume_24h: coin.total_volume,
                percent_change_24h: coin.price_change_percentage_24h,
                market_cap: coin.market_cap,
            }
        },
    }));

    console.log(`Successfully formatted ${formattedData.length} coins.`);

    // Update cache
    if (!global.__priceListCache) global.__priceListCache = {};
    global.__priceListCache = { t: now, data: formattedData };

    return res.json({ data: formattedData });

  } catch (err) {
    console.error("ERROR fetching CoinGecko market list:", err.message);
    
    // Serve stale cache if available
    if (global.__priceListCache && global.__priceListCache.data.length > 0) {
      console.warn(`Serving stale list cache due to error`);
      return res.json({ data: global.__priceListCache.data.slice(0, limit), stale: true });
    }

    return res.status(503).json({ error: "MARKET_DATA_UNAVAILABLE", message: "Could not fetch market list data." });
  }
});

const STATIC_PRICE_FALLBACKS = {
  xau: 4157.1,
  xag: 50.14,
  wti: 57.95,
  natgas: 4.67,
  xcu: 5.12,
  // Crypto defaults
  bitcoin: 65000,
  btc: 65000,
  ethereum: 3400,
  eth: 3400,
  solana: 140,
  sol: 140,
  ripple: 0.60,
  xrp: 0.60,
  toncoin: 7.0,
  ton: 7.0,
  tether: 1.00,
  usdt: 1.00,
};

function getSyntheticData(symbol) {
  const base = STATIC_PRICE_FALLBACKS[symbol] || 100;
  const rand = (Math.random() - 0.5) * 0.02; // ±1% jitter
  const price = base * (1 + rand);
  const high = price * (1 + 0.01);
  const low = price * (1 - 0.01);
  const volume = 1_000_000 * (1 + Math.random());
  const change = (Math.random() - 0.5) * 2; // ±1% change
  
  // Format based on price magnitude
  const decimals = price < 1 ? 4 : 2;
  
  return {
    price: Number(price.toFixed(decimals)),
    high_24h: Number(high.toFixed(decimals)),
    low_24h: Number(low.toFixed(decimals)),
    volume_24h: Math.round(volume),
    percent_change_24h: Number(change.toFixed(2)),
  };
}

module.exports = router;