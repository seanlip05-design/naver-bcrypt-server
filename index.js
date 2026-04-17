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
    
    // 1단계: 검색 누락 방지를 위해 검색 종료일을 target_date 기준 +3일로 넉넉하게 자동 설정
    const startDate = new Date(target_date);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 3);
    const endDateStr = endDate.toISOString().split('T')[0];

    const params = new URLSearchParams({
      lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
      lastChangedTo: `${endDateStr}T23:59:59.999+09:00`
    });

    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();
    const statuses = data.data?.lastChangeStatuses || [];

    if (statuses.length === 0) {
        return res.json({ date: target_date, pay: 0, cancel: 0, return: 0, refund: 0 });
    }

    // 중복 제거하여 주문 ID 싹쓸이
    const allIds = [...new Set(statuses.map(s => s.productOrderId))];

    // 2단계: 모은 ID로 영수증 상세 데이터 한 번에 까보기
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

        // [M열 매출] 결제일시가 정확히 "2026-04-14..." 로 시작하면 무조건 더함 (777,300원 타겟)
        const payDate = ord.paymentDate || '';
        if (payDate.startsWith(target_date)) {
          paySum += amt;
        }

        // [N, O, P열 취소/환불] 클레임 완료일 또는 환불일이 "2026-04-14..." 로 시작하면 무조건 더함 (43,000원 타겟)
        let claimDate = '';
        if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
            claimDate = clm.cancelCompletionDate || '';
        } else if (po.claimType === 'RETURN') {
            claimDate = clm.returnCompletionDate || '';
        }
        
        const refundDate = clm.refundInfo?.refundDate || '';

        // 클레임이 완료되었거나 환불된 날짜가 14일인 경우
        if (claimDate.startsWith(target_date) || refundDate.startsWith(target_date)) {
          
          if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
              cancelSum += amt;
          } else if (po.claimType === 'RETURN') {
              returnSum += amt;
          }

          // P열 환불금액 추출
          let exactRefund = clm.refundInfo?.refundAmount || 0;
          // 환불액이 명시되어 있으면 그 금액을, 아니면 상품금액 전체를 환불액으로 처리
          refundSum += (exactRefund > 0 ? exactRefund : amt);
        }
      });
    }

    res.json({ date: target_date, pay: paySum, cancel: cancelSum, return: returnSum, refund: refundSum });
  } catch (e) {
    console.error("서버 에러:", e);
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
