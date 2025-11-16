const axios = require('axios');

const API_KEY = 'fb417d74-6708-44f0-8b1d-811d7dfb31ee'; // Replace with your real API key

axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
  headers: { 'X-CMC_PRO_API_KEY': API_KEY }
})
.then(response => {
  console.log('SUCCESS! Here is some price data:');
  // Show only the first 2 coins for brevity
  console.log(response.data.data.slice(0, 2));
})
.catch(error => {
  console.error('ERROR! Unable to fetch data:', error.response?.data || error.message);
});
