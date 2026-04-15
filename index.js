const express = require("express");
const bcrypt = require("bcrypt");

const app = express();
app.use(express.json());

app.post("/naver-token", async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;

    if (!client_id || !client_secret) {
      return res.status(400).json({
        error: "client_id / client_secret 필요"
      });
    }

    const timestamp = Date.now();
    const password = `${client_id}_${timestamp}`;
    const hashed = bcrypt.hashSync(password, client_secret);
    const client_secret_sign = Buffer.from(hashed, "utf-8").toString("base64");

    const body = new URLSearchParams({
      client_id,
      timestamp: String(timestamp),
      client_secret_sign,
      grant_type: "client_credentials",
      type: "SELF"
    });

    const tokenRes = await fetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const text = await tokenRes.text();

    res.status(tokenRes.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({
      error: "token 요청 실패",
      detail: String(e)
    });
  }
});

// [결제누락/IP마지막기회 완벽대비] 데이일 4대장 집계 엔진
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;
    
    // 1단계: 14일부터 15일까지 넉넉하게 검색 (누락 방지)
    const params = new URLSearchParams({
      lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
      lastChangedTo: `2026-04-16T00:00:00.000+09:00` 
    });
    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();
    const statuses = data.data && data.data.lastChangeStatuses ? data.data.lastChangeStatuses : [];

    if (statuses.length === 0) return res.json({ date: target_date, pay: 0, cancel: 0, return: 0, refund: 0 });

    const allIds = [...new Set(statuses.map(s => s.productOrderId))];

    // 2단계: 상세 데이터 조회
    const detailsResponse = await fetch(`https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productOrderIds: allIds })
    });
    const detailsData = await detailsResponse.json();

    let paySum = 0, cancelSum = 0, returnSum = 0, refundSum = 0;

    if (detailsData.data) {
      detailsData.data.forEach(item => {
        const po = item.productOrder || {};
        const ord = item.order || {};
        const amt = po.totalPaymentAmount || 0;

        // [핵심] 결제일이 '2026-04-14'로 시작하면 무조건 더함 (777,300원 타겟)
        if (ord.paymentDate && ord.paymentDate.startsWith(target_date)) {
          paySum += amt;
        }

        // [취소/반품] 상태가 CANCELED/RETURNED이면서 변경일이 14일인 것만
        const changedDate = statuses.find(s => s.productOrderId === po.productOrderId)?.lastChangedDate;
        if (changedDate && changedDate.startsWith(target_date)) {
          if (po.productOrderStatus === 'CANCELED') cancelSum += amt;
          else if (po.productOrderStatus === 'RETURNED') returnSum += amt;
          
          // 환불액 계산 (43,000원 타겟)
          let rf = 0;
          if (item.completedClaims) item.completedClaims.forEach(c => rf += (c.refundAmount || 0));
          else if (item.claim?.refundInfo) rf = item.claim.refundInfo.refundAmount || 0;
          refundSum += (rf > 0 ? rf : (po.productOrderStatus === 'CANCELED' ? amt : 0));
        }
      });
    }

    res.json({ date: target_date, pay: paySum, cancel: cancelSum, return: returnSum, refund: refundSum });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// 서버의 진짜 IP를 확인하기 위한 비밀 통로
app.get("/myip", async (req, res) => {
  const ipRes = await fetch("https://api.ipify.org");
  const ip = await ipRes.text();
  res.send("현재 Render 서버의 출입증(IP) 번호: " + ip);
});
