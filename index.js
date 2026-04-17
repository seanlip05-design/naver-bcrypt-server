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
    
    // 1단계: 결제일 누락을 막기 위해 검색 범위를 '타겟일'부터 '현재 시점(+7일 여유)'까지 초대형으로 넓힘
    const startDate = new Date(target_date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 7);
    const endDateStr = endDate.toISOString().split('T')[0];

    const params = new URLSearchParams({
      lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
      lastChangedTo: `${endDateStr}T23:59:59.999+09:00`
    });

    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();

    // 네이버 에러 발생 시 숨기지 않고 즉시 반환
    if (data.code || data.error) {
        return res.status(400).json({ error: "네이버 차단/에러 발생", detail: data });
    }

    const statuses = data.data?.lastChangeStatuses || [];
    if (statuses.length === 0) {
        return res.json({ date: target_date, pay: 0, cancel: 0, return: 0, refund: 0 });
    }

    const allIds = [...new Set(statuses.map(s => s.productOrderId))];

    // 2단계: 상세 영수증 조회
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
        const clm = item.claim || {};
        const amt = po.totalPaymentAmount || 0;

        // ⭐️ [판매성과 데이터] - 결제금액은 오직 '결제일(paymentDate)'만 보고 독립적으로 계산 (1,305,000원 타겟)
        const payDate = ord.paymentDate || '';
        if (payDate.startsWith(target_date)) {
          paySum += amt;
        }

        // ⭐️ [클레임 데이터] - 취소/반품/환불은 오직 '클레임 완료일'만 보고 계산 (기존 완벽 로직)
        let claimDate = '';
        if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') claimDate = clm.cancelCompletionDate || '';
        else if (po.claimType === 'RETURN') claimDate = clm.returnCompletionDate || '';
        
        const refundDate = clm.refundInfo?.refundDate || '';

        if (claimDate.startsWith(target_date) || refundDate.startsWith(target_date)) {
          if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') cancelSum += amt;
          else if (po.claimType === 'RETURN') returnSum += amt;

          let exactRefund = clm.refundInfo?.refundAmount || 0;
          refundSum += (exactRefund > 0 ? exactRefund : amt);
        }
      });
    }

    res.json({ date: target_date, pay: paySum, cancel: cancelSum, return: returnSum, refund: refundSum });
  } catch (error) {
    res.status(500).json({ error: "서버 내부 에러", detail: error.message });
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
