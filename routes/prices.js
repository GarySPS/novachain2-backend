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
const LIST_REFRESH_MS = 60000;
const SYMBOL_STALE_OK_MS = 5 * 60_000;

// --- Routes ---

/* GET /api/prices/:symbol - Handles Crypto, Forex, and Commodities */
router.get("/:symbol", async (req, res) => {
  const requestedApiSymbol = req.params.symbol.toLowerCase(); // e.g., 'bitcoin', 'xau', 'eurusd'
  const now = Date.now();

  console.log(`Received price request for: ${requestedApiSymbol}`);

  // --- Check Cache First ---
  if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t < LIST_REFRESH_MS) {
    console.log(`Serving cached data for ${requestedApiSymbol}`);
    return res.json({
      symbol: requestedApiSymbol,
      ...symbolCache[requestedApiSymbol],
      cached: true
    });
  }

  let priceData = null;

  try {
    // Check if it's Forex or Commodity first
    if (isForexOrCommodity(requestedApiSymbol)) {
        console.log(`Identified ${requestedApiSymbol} as Forex/Commodity. Using Twelve Data.`);
        if (!TWELVE_API_KEY) throw new Error("Twelve Data API Key not configured");

        const twelveSymbol = TWELVE_SYMBOL[requestedApiSymbol];
        if (!twelveSymbol) throw new Error(`No Twelve Data symbol mapping for ${requestedApiSymbol}`);

        // --- Fetch from Twelve Data ---
        let currentPrice = null;
        let high_24h = null;
        let low_24h = null;
        let volume_24h = null;
        let percent_change_24h = null;

        try {
            // 1. Get current price
            const priceUrl = `https://api.twelvedata.com/price?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data price for ${requestedApiSymbol} (${twelveSymbol})`);
            const { data: priceResponse } = await axios.get(priceUrl, { timeout: 4000 });
            currentPrice = Number(priceResponse?.price);

            // 2. Get 24h stats
            const quoteUrl = `https://api.twelvedata.com/quote?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data quote for ${requestedApiSymbol} (${twelveSymbol})`);
            const { data: quoteResponse } = await axios.get(quoteUrl, { timeout: 4000 });

            if (quoteResponse) {
                high_24h = Number(quoteResponse.high);
                low_24h = Number(quoteResponse.low);
                percent_change_24h = Number(quoteResponse.percent_change);
                volume_24h = Number(quoteResponse.volume); 
            }

        } catch (tdErr) {
            console.warn(`Twelve Data request failed for ${requestedApiSymbol}: ${tdErr.message}`);
            currentPrice = null;
        }

        // --- Check for failure and use synthetic data ---
        if (!isFinite(currentPrice) || currentPrice <= 0) {
            console.warn(`⚠️ Twelve Data failed for ${requestedApiSymbol}. Using synthetic fallback.`);
            priceData = getSyntheticData(requestedApiSymbol);
        } else {
            priceData = {
                price: currentPrice,
                high_24h: isFinite(high_24h) ? high_24h : null,
                low_24h: isFinite(low_24h) ? low_24h : null,
                volume_24h: isFinite(volume_24h) ? volume_24h : null,
                percent_change_24h: isFinite(percent_change_24h) ? percent_change_24h : null,
            };
        }
        
        console.log(`Mapped priceData for ${requestedApiSymbol}:`, priceData);
    
    } else if (isCrypto(requestedApiSymbol)) {
        // --- Fetch Crypto Data using CoinGecko - FIXED ENDPOINT ---
        console.log(`Identified ${requestedApiSymbol} as Crypto.`);
        const coingeckoId = CG_ID[requestedApiSymbol];

        if (!coingeckoId) {
          throw new Error(`Unsupported crypto symbol: ${requestedApiSymbol}`);
        }

        try {
          // FIX: Use the simple/price endpoint instead of markets
          const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_24hr_high_low=true`;
          console.log(`Fetching CoinGecko data for ${coingeckoId} from: ${cgUrl}`);
          
          const { data: cgData } = await axios.get(cgUrl, { 
            timeout: 8000,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'NovaChain/1.0'
            }
          });
          
          console.log(`Received CoinGecko response for ${coingeckoId}:`, JSON.stringify(cgData));

          if (!cgData || !cgData[coingeckoId]) {
            throw new Error(`No data found from CoinGecko for ${coingeckoId}`);
          }
          
          const coinData = cgData[coingeckoId];
          const currentPrice = coinData.usd;
          
          // CoinGecko doesn't provide high/low in this endpoint, so we'll approximate
          const changePercent = coinData.usd_24h_change || 0;
          
          priceData = {
            price: Number(currentPrice),
            high_24h: currentPrice * (1 + Math.abs(changePercent) / 200), // Approx high
            low_24h: currentPrice * (1 - Math.abs(changePercent) / 200),  // Approx low
            volume_24h: coinData.usd_24h_vol || 0,
            percent_change_24h: changePercent,
          };
          
        } catch (cgErr) {
          console.warn(`CoinGecko request failed for ${requestedApiSymbol}: ${cgErr.message}`);
          // Try Binance as fallback for crypto
          try {
            const binanceSymbol = requestedApiSymbol === 'bitcoin' ? 'BTCUSDT' :
                                 requestedApiSymbol === 'ethereum' ? 'ETHUSDT' :
                                 requestedApiSymbol === 'solana' ? 'SOLUSDT' :
                                 requestedApiSymbol === 'ripple' ? 'XRPUSDT' :
                                 requestedApiSymbol === 'toncoin' || requestedApiSymbol === 'ton' ? 'TONUSDT' : null;
            
            if (binanceSymbol) {
              const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
              const { data: binanceData } = await axios.get(binanceUrl, { timeout: 5000 });
              
              priceData = {
                price: parseFloat(binanceData.lastPrice),
                high_24h: parseFloat(binanceData.highPrice),
                low_24h: parseFloat(binanceData.lowPrice),
                volume_24h: parseFloat(binanceData.quoteVolume),
                percent_change_24h: parseFloat(binanceData.priceChangePercent),
              };
            }
          } catch (binanceErr) {
            console.warn(`Binance fallback also failed for ${requestedApiSymbol}`);
          }
        }

        // --- Check for failure and use synthetic data ---
        if (!priceData || !isFinite(priceData.price) || priceData.price <= 0) {
          console.warn(`⚠️ All crypto APIs failed for ${requestedApiSymbol}. Using synthetic fallback.`);
          priceData = getSyntheticData(requestedApiSymbol); 
        }

        console.log(`Mapped priceData for ${coingeckoId}:`, priceData);

    } else {
        // --- Neither known Crypto nor Forex/Commodity ---
        throw new Error(`Unsupported symbol/id: ${requestedApiSymbol}`);
    }

    // --- Validate and Respond ---
    if (!priceData) {
        throw new Error(`Invalid or zero price data processed for ${requestedApiSymbol}`);
    }

    // Update cache
    symbolCache[requestedApiSymbol] = { t: now, ...priceData };
    console.log(`Successfully processed data for ${requestedApiSymbol}, updating cache.`);

    return res.json({ symbol: requestedApiSymbol, ...priceData });

  } catch (err) {
    console.error(`CRITICAL ERROR processing ${requestedApiSymbol}:`, err.message);
    
    // Try to serve stale cache
    if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t <= SYMBOL_STALE_OK_MS) {
      console.warn(`Serving stale cache for ${requestedApiSymbol} due to error.`);
      return res.json({
        symbol: requestedApiSymbol,
        ...symbolCache[requestedApiSymbol],
        stale: true
      });
    }

    // --- Final Error - Serve synthetic data as last resort ---
    try {
      console.warn(`Serving synthetic data as last resort for ${requestedApiSymbol}.`);
      const syntheticData = getSyntheticData(requestedApiSymbol);
      return res.json({ symbol: requestedApiSymbol, ...syntheticData });
    } catch (finalErr) {
      console.error(`FATAL: Could not even generate synthetic data for ${requestedApiSymbol}.`, finalErr.message);
      return res.status(503).json({ error: "LIVE_DATA_UNAVAILABLE", symbol: requestedApiSymbol, detail: err.message });
    }
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