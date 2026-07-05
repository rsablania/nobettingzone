const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false 
  }
});

async function testConnection() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ No DATABASE_URL found in your environment!');
    return;
  }

  // Mask the password for safe logging
  const maskedUrl = url.replace(/:[^:@]+@/, ':***@');
  console.log('Attempting to connect using:\n' + maskedUrl + '\n');

  try {
    const client = await pool.connect();
    console.log('✅ CONNECTED SUCCESSFULLY!');
    
    // Run a quick ping query
    const res = await client.query('SELECT NOW() AS current_time');
    console.log('🕒 Database Time:', res.rows[0].current_time);
    
    client.release();
  } catch (err) {
    console.error('❌ CONNECTION FAILED!');
    console.error('Error Code:', err.code);
    console.error('Error Message:', err.message);
  } finally {
    await pool.end();
  }
}

testConnection();