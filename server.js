const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://sandbox.safaricom.co.ke";

// Temporary payment storage for testing.
// This is cleared when the server restarts.
const payments = new Map();
const earlyCallbacks = new Map();

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

  const p = Object.fromEntries(
    parts.map(x => [x.type, x.value])
  );

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
  res.json({
    status: "online",
    service: "WOLLACE"
  });
});

// Send M-Pesa STK Push
app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const {
      phoneNumber,
      amount,
      accountReference
    } = req.body;

    let phone = String(phoneNumber || "")
      .replace(/\s/g, "");

    if (phone.startsWith("07") && phone.length === 10) {
      phone = "254" + phone.substring(1);
    }

    if (!/^2547\d{8}$/.test(phone)) {
      return res.status(400).json({
        error: "Enter a valid Kenyan Safaricom number."
      });
    }

    const value = Number(amount);

    if (!Number.isInteger(value) ||
        value < 1 || value > 250000) {
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
          AccountReference: String(
            accountReference || "WOLLACE"
          ).slice(0, 12),
          TransactionDesc: "WOLLACE Payment"
        })
      }
    );

    const data = await response.json();

    if (!response.ok || String(data.ResponseCode) !== "0") {
      return res.status(response.ok ? 400 : response.status)
        .json(data);
    }

    const checkoutID = data.CheckoutRequestID;

    if (checkoutID) {
      const early = earlyCallbacks.get(checkoutID);

      payments.set(checkoutID, early || {
        status: "pending",
        amount: value,
        phoneNumber: phone,
        accountReference: accountReference || "WOLLACE",
        checkoutRequestID: checkoutID
      });

      earlyCallbacks.delete(checkoutID);
    }

    res.json({
      ...data,
      paymentStatus: "pending",
      message: "M-Pesa prompt sent. Waiting for confirmation."
    });

  } catch (error) {
    console.error("STK Push error:", error.message);

    res.status(500).json({
      error: "Unable to initiate M-Pesa payment."
    });
  }
});

// Receive Safaricom payment confirmation
app.post("/api/mpesa/callback", (req, res) => {
  try {
    console.log(
      "WOLLACE M-Pesa Callback:",
      JSON.stringify(req.body)
    );

    const callback = req.body?.Body?.stkCallback;

    if (!callback || !callback.CheckoutRequestID) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutID = callback.CheckoutRequestID;
    const resultCode = Number(callback.ResultCode);

    let receipt = null;
    let paidAmount = null;
    let phoneNumber = null;

    const items =
      callback.CallbackMetadata?.Item || [];

    for (const item of items) {
      if (item.Name === "MpesaReceiptNumber") {
        receipt = item.Value;
      }

      if (item.Name === "Amount") {
        paidAmount = item.Value;
      }

      if (item.Name === "PhoneNumber") {
        phoneNumber = item.Value;
      }
    }

    const payment = {
      checkoutRequestID: checkoutID,
      status: resultCode === 0 ? "successful" : "failed",
      resultCode,
      resultDescription: callback.ResultDesc,
      receipt,
      amount: paidAmount,
      phoneNumber,
      completedAt: new Date().toISOString()
    };

    if (payments.has(checkoutID)) {
      payments.set(checkoutID, {
        ...payments.get(checkoutID),
        ...payment
      });
    } else {
      earlyCallbacks.set(checkoutID, payment);
    }

    console.log("Payment result:", payment);

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (error) {
    console.error("Callback error:", error.message);

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

// Check payment status
app.get("/api/mpesa/status", (req, res) => {
  const checkoutID = String(
    req.query.checkoutRequestID || ""
  );

  if (!checkoutID) {
    return res.status(400).json({
      error: "CheckoutRequestID is required."
    });
  }

  const payment = payments.get(checkoutID);

  if (!payment) {
    return res.json({
      status: "unknown",
      message: "Payment status not yet available."
    });
  }

  res.json(payment);
});

app.listen(PORT, () => {
  console.log(
    `WOLLACE server running on port ${PORT}`
  );
});
    
