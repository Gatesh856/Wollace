
const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

const BASE_URL = "https://sandbox.safaricom.co.ke";

function getTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));

  return p.year + p.month + p.day +
    p.hour + p.minute + p.second;
}

async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Daraja authentication failed");
  }

  return data.access_token;
}

app.get("/", (req, res) => {
  res.send("WOLLACE M-Pesa Backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ status: "online", service: "WOLLACE" });
});

// Initiate M-Pesa STK Push
app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { phoneNumber, amount, accountReference } = req.body;

    const phone = String(phoneNumber || "").replace(/\s/g, "");
    const value = Number(amount);

    if (!/^2547\d{8}$/.test(phone)) {
      return res.status(400).json({
        error: "Enter a valid Kenyan Safaricom number in 254 format."
      });
    }

    if (!Number.isInteger(value) || value < 1 || value > 250000) {
      return res.status(400).json({
        error: "Enter a valid payment amount."
      });
    }

    const shortcode = process.env.BUSINESS_SHORTCODE;
    const passkey = process.env.PASSKEY;
    const callbackURL = process.env.CALLBACK_URL;

    if (!shortcode || !passkey || !callbackURL) {
      throw new Error("Missing M-Pesa environment settings");
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();

    const password = Buffer.from(
      shortcode + passkey + timestamp
    ).toString("base64");

    const response = await fetch(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: value,
          PartyA: phone,
          PartyB: shortcode,
          PhoneNumber: phone,
          CallBackURL: callbackURL,
          AccountReference: String(accountReference || "WOLLACE").slice(0, 12),
          TransactionDesc: "WOLLACE Payment"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);

  } catch (error) {
    console.error("STK Push error:", error.message);
    res.status(500).json({
      error: "Unable to initiate M-Pesa payment."
    });
  }
});

// Receive Safaricom payment callback
app.post("/api/mpesa/callback", (req, res) => {
  console.log(
    "WOLLACE M-Pesa Callback:",
    JSON.stringify(req.body)
  );

  // Payment results must be verified and saved
  // before marking an installment as paid.

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

app.listen(PORT, () => {
  console.log(`WOLLACE server running on port ${PORT}`);
});
  
