
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { Pool } = require("pg");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing");
  process.exit(1);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(
    password,
    salt,
    120000,
    32,
    "sha256"
  ).toString("hex");
}

function createToken(user) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      exp: Math.floor(Date.now() / 1000) + 86400
    })
  ).toString("base64url");

  const signature = crypto.createHmac("sha256", JWT_SECRET)
    .update(header + "." + payload)
    .digest("base64url");

  return header + "." + payload + "." + signature;
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();

    const expected = crypto.createHmac("sha256", JWT_SECRET)
      .update(parts[0] + "." + parts[1])
      .digest();

    const actual = Buffer.from(parts[2], "base64url");

    if (actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)) {
      throw new Error();
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    );

    if (payload.exp < Date.now() / 1000) throw new Error();

    req.userId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      referral_code TEXT NOT NULL UNIQUE,
      referred_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount NUMERIC(12,2) NOT NULL,
      type TEXT NOT NULL,
      reference TEXT UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount NUMERIC(12,2) NOT NULL,
      upi_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

app.get("/", (req, res) => {
  res.json({
    app: "VINOD AVJS ROYAL APPS",
    status: "Backend running",
    version: "1.0.0"
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "OK", database: "connected" });
  } catch {
    res.status(503).json({ status: "Database unavailable" });
  }
});

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, referralCode } = req.body;

    if (!name || !email || !password || password.length < 8) {
      return res.status(400).json({
        error: "Name, email and password (8+ characters) required"
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    let referrer = null;

    if (referralCode) {
      const r = await pool.query(
        "SELECT id FROM users WHERE referral_code=$1",
        [referralCode.trim()]
      );

      if (!r.rows.length) {
        return res.status(400).json({
          error: "Invalid referral code"
        });
      }

      referrer = r.rows[0].id;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const code = crypto.randomBytes(5).toString("hex").toUpperCase();

    const result = await pool.query(
      `INSERT INTO users
       (name,email,password_hash,salt,referral_code,referred_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,name,email,referral_code`,
      [name.trim(), normalizedEmail, passwordHash, salt, code, referrer]
    );

    const user = result.rows[0];

    res.status(201).json({
      message: "Registration successful",
      user,
      token: createToken(user)
    });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error(e);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [(email || "").trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const user = result.rows[0];
    const hash = hashPassword(password || "", user.salt);

    if (hash !== user.password_hash) {
      return res.status(401).json({ error: "Invalid login" });
    }

    res.json({
      token: createToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        referral_code: user.referral_code
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
});

// User profile and wallet
app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await pool.query(
      `SELECT id,name,email,referral_code,created_at
       FROM users WHERE id=$1`,
      [req.userId]
    );

    if (!user.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const balance = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS balance
       FROM ledger WHERE user_id=$1`,
      [req.userId]
    );

    res.json({
      user: user.rows[0],
      balance: balance.rows[0].balance
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// Wallet history
app.get("/api/wallet/history", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,amount,type,description,created_at
       FROM ledger WHERE user_id=$1
       ORDER BY id DESC LIMIT 100`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "History unavailable" });
  }
});

// Referral information
app.get("/api/referrals", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT referral_code,
       (SELECT COUNT(*) FROM users
        WHERE referred_by=$1) AS referrals
       FROM users WHERE id=$1`,
      [req.userId]
    );

    res.json(result.rows[0] || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Referral data unavailable" });
  }
});

// Withdrawal request (minimum ₹100)
app.post("/api/withdraw", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { amount, upiId } = req.body;
    const value = Number(amount);

    if (!Number.isFinite(value) || value < 100 ||
        !/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(upiId || "")) {
      return res.status(400).json({
        error: "Minimum withdrawal ₹100 and valid UPI ID required"
      });
    }

    await client.query("BEGIN");

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS balance
       FROM ledger WHERE user_id=$1`,
      [req.userId]
    );

    const balance = Number(balanceResult.rows[0].balance);

    if (balance < value) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const withdrawal = await client.query(
      `INSERT INTO withdrawals(user_id,amount,upi_id)
       VALUES($1,$2,$3) RETURNING id`,
      [req.userId, value, upiId]
    );

    await client.query(
      `INSERT INTO ledger(user_id,amount,type,reference,description)
       VALUES($1,$2,'withdrawal',$3,$4)`,
      [
        req.userId,
        -value,
        "withdrawal-" + withdrawal.rows[0].id,
        "Withdrawal requested"
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Withdrawal request submitted",
      status: "Pending",
      withdrawalId: withdrawal.rows[0].id
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Withdrawal failed" });
  } finally {
    client.release();
  }
});

// Withdrawal history
app.get("/api/withdrawals", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,amount,status,created_at
       FROM withdrawals WHERE user_id=$1
       ORDER BY id DESC`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load withdrawals" });
  }
});

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on port " + PORT);
    });
  })
  .catch((e) => {
    console.error("Database setup failed:", e);
    process.exit(1);
  });
