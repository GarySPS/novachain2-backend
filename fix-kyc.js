// fix-kyc.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nova.db');

db.run(
  "UPDATE users SET kyc_status = 'unverified' WHERE kyc_status IS NULL OR kyc_status = 'pending';",
  function(err) {
    if (err) {
      console.error("❌ Error updating kyc_status:", err.message);
    } else {
      console.log("✅ All existing users set to 'unverified' (unless already approved)");
    }
    db.close();
  }
);
