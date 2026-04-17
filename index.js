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

//
const express = require('express');
const fetch = require('node-fetch'); // node-fetch 필수
const app = express();
app.use(express.json());

app.post('/naver-daily-summary', async (req, res) => {
    try {
        const { access_token, target_date } = req.body;
        if (!access_token || !target_date) return res.status(400).json({ error: '토큰/날짜 누락' });

        // 챗GPT의 분리형 구조 대신, 한번의 요청으로 결제/취소/환불을 완벽하게 뜯어오는 함수 실행
        const result = await getNaverDataCorrectly_(access_token, target_date);

        return res.json({
            date: target_date,
            pay: result.pay,
            cancel: result.cancel,
            return: result.return,
            refund: result.refund,
            DEBUG: result.debugMsg // 화면에 결과 내역을 출력합니다
        });
    } catch (error) {
        return res.status(500).json({ error: '에러발생', detail: String(error) });
    }
});

// 네이버 API 현실에 맞춘 무적의 추출 함수
async function getNaverDataCorrectly_(access_token, target_date) {
    // 1. 타겟 날짜 기준 과거 30일 ~ 내일까지 넉넉하게 싹 다 긁어옵니다 (누락 방지)
    const start = new Date(target_date);
    start.setDate(start.getDate() - 30);
    const startStr = start.toISOString().split('T')[0];

    const end = new Date(target_date);
    end.setDate(end.getDate() + 1); 
    const endStr = end.toISOString().split('T')[0];

    const params = new URLSearchParams({
        lastChangedFrom: `${startStr}T00:00:00.000+09:00`,
        lastChangedTo: `${endStr}T23:59:59.999+09:00`
    });

    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await response.json();

    if (!data.data || !data.data.lastChangeStatuses) {
        return { pay:0, cancel:0, return:0, refund:0, debugMsg: "해당 기간에 변경된 주문이 아예 없습니다." };
    }

    // 중복 ID 제거 (에러 방지)
    const allIds = [...new Set(data.data.lastChangeStatuses.map(s => s.productOrderId))];
    if (allIds.length === 0) return { pay:0, cancel:0, return:0, refund:0, debugMsg: "주문 ID가 없습니다." };

    // 2. 상세 내역 조회 (한 번에 최대 300개 제한 준수)
    const detailsResponse = await fetch(`https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productOrderIds: allIds.slice(0, 300) })
    });
    const detailsData = await detailsResponse.json();

    let paySum = 0, cancelSum = 0, returnSum = 0, refundSum = 0;
    let foundRefunds = 0; // 16일 환불건수 체크용

    if (detailsData.data) {
        detailsData.data.forEach(item => {
            const po = item.productOrder || {};
            const ord = item.order || {};
            const clm = item.claim || {};
            const amt = Number(po.totalPaymentAmount || 0);

            // [결제액] 결제일이 정확히 target_date(예: 16일)인 것만 합산
            if (ord.paymentDate && ord.paymentDate.startsWith(target_date)) {
                paySum += amt;
            }

            const cancelDate = clm.cancelCompletionDate || '';
            const returnDate = clm.returnCompletionDate || '';
            const refundDate = clm.refundInfo?.refundDate || cancelDate || returnDate || '';

            // [취소액] 취소완료일 기준
            if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
                if (cancelDate.startsWith(target_date)) cancelSum += amt;
            }
            // [반품액] 반품완료일 기준
            if (po.claimType === 'RETURN') {
                if (returnDate.startsWith(target_date)) returnSum += amt;
            }
            // [환불액] 챗GPT의 엉터리 로직 제거하고, 진짜 환불된 날짜만 엄격하게 검사
            if (refundDate.startsWith(target_date)) {
                let exactRefund = Number(clm.refundInfo?.refundAmount || 0);
                refundSum += (exactRefund > 0 ? exactRefund : amt);
                foundRefunds++;
            }
        });
    }

    return {
        pay: paySum,
        cancel: cancelSum,
        return: returnSum,
        refund: refundSum,
        debugMsg: `스캔한 주문 수: ${allIds.length}개 / ${target_date} 환불건 발견: ${foundRefunds}건`
    };
}

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
