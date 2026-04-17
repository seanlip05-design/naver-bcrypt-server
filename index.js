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

const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;
    const targetDateStr = target_date.trim(); // 예: "2026-04-16"

    // ⭐️ 핵심: 환불건을 절대 놓치지 않기 위해, 과거 30일치 변경 내역을 싹 다 긁어옵니다.
    const startDate = new Date(targetDateStr);
    startDate.setDate(startDate.getDate() - 30);
    const startDateStr = startDate.toISOString().split('T')[0];
    
    const endDate = new Date(targetDateStr);
    endDate.setDate(endDate.getDate() + 7);
    const endDateStr = endDate.toISOString().split('T')[0];

    const params = new URLSearchParams({
      lastChangedFrom: `${startDateStr}T00:00:00.000+09:00`,
      lastChangedTo: `${endDateStr}T23:59:59.999+09:00`
    });

    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();

    if (!data.data || !data.data.lastChangeStatuses) {
        return res.json({ date: targetDateStr, pay: 0, cancel: 0, return: 0, refund: 0, DEBUG: "API 응답에 주문 내역이 없습니다." });
    }

    const allIds = [...new Set(data.data.lastChangeStatuses.map(s => s.productOrderId))];
    if (allIds.length === 0) {
         return res.json({ date: targetDateStr, pay: 0, cancel: 0, return: 0, refund: 0, DEBUG: "주문 ID가 존재하지 않습니다." });
    }

    // 상세 정보 조회 (네이버 API)
    const detailsResponse = await fetch(`https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productOrderIds: allIds.slice(0, 300) }) // 한 번에 최대 300개 스캔
    });
    const detailsData = await detailsResponse.json();

    let paySum = 0, cancelSum = 0, returnSum = 0, refundSum = 0;

    if (detailsData.data) {
      detailsData.data.forEach(item => {
        const po = item.productOrder || {};
        const ord = item.order || {};
        const clm = item.claim || {};
        const amt = po.totalPaymentAmount || 0;

        // 1. 결제금액 (정확히 target_date에 결제된 것만)
        if (ord.paymentDate && ord.paymentDate.startsWith(targetDateStr)) {
            paySum += amt;
        }

        // 날짜 추출
        const cancelDate = clm.cancelCompletionDate || '';
        const returnDate = clm.returnCompletionDate || '';
        const refundDate = clm.refundInfo?.refundDate || cancelDate || returnDate || '';
        
        // 2. 취소금액
        if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
            if (cancelDate.startsWith(targetDateStr)) cancelSum += amt;
        }
        // 3. 반품금액
        if (po.claimType === 'RETURN') {
            if (returnDate.startsWith(targetDateStr)) returnSum += amt;
        }
        // 4. 환불금액 (취소든 반품이든 환불이 완료된 날짜 기준)
        if (refundDate.startsWith(targetDateStr)) {
            let exactRefund = clm.refundInfo?.refundAmount || 0;
            refundSum += (exactRefund > 0 ? exactRefund : amt);
        }
      });
    }

    res.json({
        date: targetDateStr,
        pay: paySum,
        cancel: cancelSum,
        return: returnSum,
        refund: refundSum,
        DEBUG: `✅ 서버 업데이트 완료. 총 ${allIds.length}개 주문 스캔 적용.` // 이 문구가 떠야 정상입니다!
    });
  } catch (e) {
    res.status(500).json({ error: "서버 에러", detail: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
