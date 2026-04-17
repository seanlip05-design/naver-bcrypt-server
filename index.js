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

// [결제금액 누락 완벽 해결] 데이일 4대장 집계 엔진
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;
    
    // 1단계: '상태' 따지지 말고, 어제 털끝 하나라도 변경된 주문 내역 싹 다 가져오기
    const params = new URLSearchParams({
      lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
      lastChangedTo: `${target_date}T23:59:59.999+09:00`
    });
    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();
    
    const statuses = data.data && data.data.lastChangeStatuses ? data.data.lastChangeStatuses : [];
    if (statuses.length === 0) {
       return res.json({ date: target_date, pay: 0, cancel: 0, return: 0, refund: 0 });
    }

    const idMap = {};
    const allIds = [];
    statuses.forEach(s => {
       idMap[s.productOrderId] = s.lastChangedType;
       allIds.push(s.productOrderId);
    });

    // 2단계: 모아온 전체 ID로 상세 데이터(영수증) 열어보기
    const detailsUrl = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`;
    const detailsResponse = await fetch(detailsUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productOrderIds: allIds })
    });
    const detailsData = await detailsResponse.json();

    let totalPay = 0, totalCancel = 0, totalReturn = 0, totalRefund = 0;

    if (detailsData.data && Array.isArray(detailsData.data)) {
      detailsData.data.forEach(detail => {
        const po = detail.productOrder || {};
        const ord = detail.order || {};   // ⭐️ 여기가 핵심 (order 보따리에서 꺼내도록 수정)
        const id = po.productOrderId;
        const lastType = idMap[id];
        const amt = po.totalPaymentAmount || 0;

        // [M열] 결제금액: ord(order 보따리)에서 결제 날짜가 '어제(target_date)'인지 정확히 확인!
        if (ord.paymentDate && ord.paymentDate.startsWith(target_date)) {
          totalPay += amt;
        }

        // [N, O, P열] 취소/반품: (이 부분은 아까 43,000원 완벽하게 맞았으므로 건드리지 않았습니다)
        if (lastType === 'CLAIM_COMPLETED') {
            if (po.productOrderStatus === 'CANCELED') {
                totalCancel += amt; 
            } else if (po.productOrderStatus === 'RETURNED') {
                totalReturn += amt; 
            } else {
                if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') totalCancel += amt;
                else if (po.claimType === 'RETURN') totalReturn += amt;
            }

            let exactRefund = 0;
            if (detail.completedClaims && detail.completedClaims.length > 0) {
               detail.completedClaims.forEach(c => exactRefund += (c.refundAmount || c.totalRefundAmount || 0));
            } else if (detail.claim && detail.claim.refundInfo) {
               exactRefund += (detail.claim.refundInfo.refundAmount || 0);
            }
            totalRefund += (exactRefund > 0 ? exactRefund : amt);
        }
      });
    }

    res.json({
      date: target_date,
      pay: totalPay,
      cancel: totalCancel,
      return: totalReturn,
      refund: totalRefund
    });

  } catch (error) {
    console.error('집계 에러:', error);
    res.status(500).json({ error: '데이터 집계 실패', detail: String(error) });
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
