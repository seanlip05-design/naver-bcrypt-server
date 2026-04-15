const express = require("express");
const bcrypt = require("bcrypt");

const app = express();
app.use(express.json());

app.post("/make-bcrypt", async (req, res) => {
  try {
    const { client_id, client_secret, timestamp } = req.body;

    let tsNum = parseInt(timestamp, 10);
    if (String(tsNum).length === 10) tsNum *= 1000;

    const password = `${client_id}_${tsNum}`;
    const hashed = bcrypt.hashSync(password, client_secret);
    const client_secret_sign = Buffer.from(hashed, "utf-8").toString("base64");

    res.json({
      client_secret_sign,
      timestamp: tsNum
    });
  } catch (e) {
    res.status(500).json({
      error: "bcrypt 생성 실패",
      detail: String(e)
    });
  }
});

const port = process.env.PORT || 3018;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});